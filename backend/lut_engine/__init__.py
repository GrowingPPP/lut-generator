import dataclasses

from .params import LutParams
from .lut3d import generate_lut, build_grid
from .cube import lut_to_cube, PHOTO_STYLE_TAGS
from .recipe import (RecipeError, apply_recipe, input_contract, neutral_recipe_params,
                     validate_recipe, validate_input_contract)

__all__ = [
    "LutParams",
    "generate_lut",
    "build_grid",
    "lut_to_cube",
    "PHOTO_STYLE_TAGS",
    "lut_params_from_dict",
    "RecipeError", "apply_recipe", "input_contract", "neutral_recipe_params",
    "validate_recipe", "validate_input_contract",
]

_LUT_PARAM_FIELDS = {f.name for f in dataclasses.fields(LutParams)}


def lut_params_from_dict(d: dict) -> LutParams:
    """dict → 引擎 LutParams,构造时 __post_init__ 会 clamp 到合法范围。

    只保留 LutParams 已知字段,忽略未知键;lift/gamma/gain 接受 list 或 tuple。
    这是 dict→LutParams 的唯一入口,避免各调用点逐字段列参导致漏字段。
    """
    d = {k: v for k, v in dict(d).items() if k in _LUT_PARAM_FIELDS}
    for k in ("lift", "gamma", "gain"):
        if k in d and d[k] is not None:
            d[k] = tuple(d[k])
    return LutParams(**d)
