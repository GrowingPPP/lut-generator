"""可移植风格配方:校验依赖、输入契约与原子应用。"""
from dataclasses import asdict
from math import isfinite

from .params import LutParams, PHOTO_STYLES

TECHNICAL_FIELDS = {"base_photo_style", "tone_map"}
RGB_FIELDS = {"lift", "gamma", "gain"}
PARAM_FIELDS = set(asdict(LutParams()))
STYLE_FIELDS = PARAM_FIELDS - TECHNICAL_FIELDS
DEPENDENCIES = {
    "contrast": {"contrast_pivot"},
    "selective_hue_shift": {"selective_hue_center", "selective_hue_width"},
    "selective_saturation": {"selective_hue_center", "selective_hue_width"},
    "split_shadow_sat": {"split_shadow_hue", "split_balance"},
    "split_highlight_sat": {"split_highlight_hue", "split_balance"},
    "split_mid_sat": {"split_mid_hue", "split_balance"},
}


class RecipeError(ValueError):
    def __init__(self, code, message, fields=None):
        super().__init__(message)
        self.code = code
        self.fields = sorted(fields or [])


def _number(value, field):
    if isinstance(value,bool) or not isinstance(value,(int,float)):
        raise RecipeError("invalid_number",f"{field} 必须是有限数字",[field])
    try:
        number = float(value)
    except OverflowError as exc:
        raise RecipeError("invalid_number",f"{field} 必须是有限数字",[field]) from exc
    if not isfinite(number):
        raise RecipeError("invalid_number",f"{field} 必须是有限数字",[field])
    return number


def validate_params(params):
    """补齐中性值,拒绝未知项、类型错误及任何引擎夹取。"""
    if not isinstance(params, dict):
        raise RecipeError("invalid_params", "参数必须是对象")
    unknown = set(params) - PARAM_FIELDS
    if unknown:
        raise RecipeError("unknown_fields", "包含 LUT 不支持的参数", unknown)
    full = asdict(LutParams())
    full.update(params)
    if full["base_photo_style"] not in PHOTO_STYLES:
        raise RecipeError("invalid_input", "输入 Photo Style 无效", ["base_photo_style"])
    for key, value in list(full.items()):
        if key == "base_photo_style":
            continue
        if key in RGB_FIELDS:
            if not isinstance(value, (list, tuple)) or len(value) != 3:
                raise RecipeError("invalid_rgb", f"{key} 必须是三个通道", [key])
            full[key] = [_number(v, key) for v in value]
        else:
            full[key] = _number(value, key)
    clamped = asdict(LutParams(**full))
    invalid = [key for key, value in full.items()
               if (list(clamped[key]) if key in RGB_FIELDS else clamped[key]) != value]
    if invalid:
        raise RecipeError("out_of_range", "应用后的参数超出范围,未执行夹取", invalid)
    return full


def input_contract(params):
    full = validate_params(params)
    return {"base_photo_style": full["base_photo_style"],
            "tone_map": full["tone_map"],
            "output_encoding": "Rec709" if full["base_photo_style"] == "VLOG" else "sRGB"}


def validate_input_contract(contract):
    if not isinstance(contract, dict) or set(contract) != {"base_photo_style", "tone_map", "output_encoding"}:
        raise RecipeError("invalid_input_contract", "输入契约必须明确基准、tone_map 和输出编码")
    expected = input_contract({"base_photo_style": contract["base_photo_style"], "tone_map": contract["tone_map"]})
    if contract != expected:
        raise RecipeError("invalid_input_contract", "输出编码与输入基准不一致")
    return expected


def validate_recipe(recipe):
    if not isinstance(recipe, dict):
        raise RecipeError("invalid_recipe", "配方必须是对象")
    allowed = {"format_version", "schema_version", "kind", "input_contract", "operations", "source"}
    if set(recipe) - allowed:
        raise RecipeError("unknown_recipe_fields", "配方包含未知字段", set(recipe) - allowed)
    version = recipe.get("format_version", recipe.get("schema_version"))
    if (type(version) is not int or version != 1
            or type(recipe.get("schema_version",version)) is not int
            or recipe.get("schema_version",version) != version
            or recipe.get("kind","portable_style") != "portable_style"):
        raise RecipeError("invalid_recipe_version", "仅支持 portable_style 格式 1")
    contract = validate_input_contract(recipe.get("input_contract"))
    operations = recipe.get("operations")
    if not isinstance(operations, dict) or not operations:
        raise RecipeError("empty_recipe", "没有可保存的风格贡献")
    unknown = set(operations) - STYLE_FIELDS
    if unknown:
        raise RecipeError("unknown_fields", "配方不能修改技术输入或不存在的调整项", unknown)
    normalized = {}
    for field, operation in operations.items():
        if not isinstance(operation, dict) or set(operation) - {"mode", "value", "dependency"}:
            raise RecipeError("invalid_operation", f"{field} 的操作格式无效", [field])
        mode = operation.get("mode")
        if mode not in ("add", "set") or "value" not in operation:
            raise RecipeError("invalid_operation", f"{field} 必须明确 add/set 与 value", [field])
        dependency = operation.get("dependency", False)
        if type(dependency) is not bool or (dependency and mode != "set"):
            raise RecipeError("invalid_dependency", "依赖项必须使用 set", [field])
        value = operation["value"]
        if field in RGB_FIELDS:
            if not isinstance(value, (list, tuple)) or len(value) != 3:
                raise RecipeError("invalid_rgb", f"{field} 必须是三个通道", [field])
            value = [_number(v, field) for v in value]
        else:
            value = _number(value, field)
        if mode == "set":
            validate_params({field: value})
        normalized[field] = {"mode": mode, "value": value, **({"dependency": True} if dependency else {})}
    effect_fields = {field for field, op in normalized.items() if not op.get("dependency")}
    if not effect_fields or all(normalized[field]["mode"] == "add" and
            (all(value == 0 for value in normalized[field]["value"]) if field in RGB_FIELDS
             else normalized[field]["value"] == 0) for field in effect_fields):
        raise RecipeError("empty_recipe","配方没有有效风格贡献")
    needed = set()
    for field in effect_fields:
        needed.update(DEPENDENCIES.get(field, set()))
    if effect_fields - {"temp", "tint", "exposure", "look_strength"}:
        needed.add("look_strength")
    missing = {field for field in needed if normalized.get(field, {}).get("mode") != "set"}
    if missing:
        raise RecipeError("missing_dependencies","配方缺少明确的作用范围依赖",missing)
    orphaned = {field for field,op in normalized.items() if op.get("dependency") and field not in needed}
    if orphaned:
        raise RecipeError("invalid_dependency","作用范围项不是配方所需的依赖",orphaned)
    source = recipe.get("source", {})
    if not isinstance(source, dict):
        raise RecipeError("invalid_source", "配方来源必须是对象")
    return {"format_version": 1, "kind": "portable_style", "input_contract": contract,
            "operations": normalized, "source": source}


def apply_recipe(recipe, params, locked_fields=()):
    """整体成功或整体拒绝;不修改调用方的当前参数。"""
    recipe = validate_recipe(recipe)
    current = validate_params(params)
    if input_contract(current) != recipe["input_contract"]:
        raise RecipeError("input_conflict", "配方与当前输入基准或显示转换不一致", TECHNICAL_FIELDS)
    unknown_locks = set(locked_fields) - PARAM_FIELDS
    if unknown_locks:
        raise RecipeError("unknown_locks", "保护项不属于现有参数", unknown_locks)
    candidate = dict(current)
    for field, op in recipe["operations"].items():
        value = op["value"]
        if op["mode"] == "set":
            candidate[field] = value
        elif field in RGB_FIELDS:
            candidate[field] = [a + b for a, b in zip(current[field], value)]
        else:
            candidate[field] = current[field] + value
        if field == "hue":
            candidate[field] = (candidate[field] + 180.0) % 360.0 - 180.0
    changes = {field: {"before": current[field], "after": value}
               for field, value in candidate.items() if value != current[field]}
    conflicts = set(changes) & set(locked_fields)
    if conflicts:
        raise RecipeError("lock_conflict", "配方会修改受保护参数,请先明确解除保护", conflicts)
    return validate_params(candidate), changes


def neutral_recipe_params(recipe):
    recipe = validate_recipe(recipe)
    neutral = {"base_photo_style": recipe["input_contract"]["base_photo_style"],
               "tone_map": recipe["input_contract"]["tone_map"]}
    return apply_recipe(recipe, neutral)[0]
