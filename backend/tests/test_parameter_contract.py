"""AI 工具、API、引擎与手调控件使用同一参数契约。"""
import re
from pathlib import Path

from agent.auto import READONLY_FIELDS
from agent.schemas import CorrectionProposal, ExtractResult, STYLE_FIELDS, AVAILABLE_FIELDS, MANUAL_EFFECT_FIELDS, build_tool_schema
from api.models import LutParamsModel
from lut_engine import LutParams


APP = Path(__file__).resolve().parents[2] / "frontend/src/App.jsx"


def _value_schema(schema):
    return next((item for item in schema.get("anyOf", []) if item.get("type") != "null"), schema)


def _bounds(schema):
    if schema.get("type") == "array":
        schema = schema["items"]
    return schema.get("minimum"), schema.get("maximum")


def _ui_ranges():
    source = APP.read_text(encoding="utf-8")
    ranges = {
        key: (float(low), float(high))
        for key, low, high in re.findall(
            r"\{ key: '(\w+)', label: '[^']*', min: (-?[\d.]+), max: (-?[\d.]+)", source
        )
    }
    mapping = re.search(r'aria-label="V-Log 显示映射"(.*?)onChange=', source, re.S)
    assert mapping, "V-Log 显示映射控件未定义"
    low = re.search(r"min=\{([\d.]+)\}", mapping.group(1))
    high = re.search(r"max=\{([\d.]+)\}", mapping.group(1))
    assert low and high
    ranges["tone_map"] = (float(low.group(1)), float(high.group(1)))
    return ranges


def test_ai_outputs_only_parameters_available_in_manual_controls():
    fields = set(LutParams.__dataclass_fields__)
    assert set(LutParamsModel.model_fields) == fields
    assert fields == set(AVAILABLE_FIELDS)
    assert set(ExtractResult.model_fields) - {"intent"} == fields - set(MANUAL_EFFECT_FIELDS) == set(STYLE_FIELDS)
    assert set(_ui_ranges()) | {"base_photo_style"} | set(MANUAL_EFFECT_FIELDS) == fields
    assert set(CorrectionProposal.model_fields) - {"diagnosis"} <= fields - set(READONLY_FIELDS)
    tool = build_tool_schema()["function"]["parameters"]
    assert set(tool["properties"]) - {"intent"} == fields - set(MANUAL_EFFECT_FIELDS)
    assert tool["additionalProperties"] is False


def test_ai_absolute_value_bounds_match_api_and_manual_controls():
    api = LutParamsModel.model_json_schema()["properties"]
    ai = build_tool_schema()["function"]["parameters"]["properties"]
    for key, bounds in _ui_ranges().items():
        assert _bounds(api[key]) == bounds, f"{key}: API 范围与手调控件不一致"
        if key not in MANUAL_EFFECT_FIELDS:
            assert _bounds(_value_schema(ai[key])) == bounds, f"{key}: AI 范围与手调控件不一致"
    assert _value_schema(ai["base_photo_style"])["enum"] == api["base_photo_style"]["enum"]
    styles = re.search(r"const PHOTO_STYLES = \[(.*?)\n\]", APP.read_text(encoding="utf-8"), re.S)
    assert styles, "输入基准控件选项未定义"
    assert re.findall(r"value: '([^']+)'", styles.group(1)) == api["base_photo_style"]["enum"]
    for key in ("lift", "gamma", "gain"):
        for schema in (api[key], _value_schema(ai[key])):
            assert (schema["minItems"], schema["maxItems"]) == (3, 3)


def test_engine_clamp_matches_declared_parameter_limits():
    for key, (low, high) in _ui_ranges().items():
        assert low is not None and high is not None
        if key in {"lift", "gamma", "gain"}:
            assert getattr(LutParams(**{key: [low - 1] * 3}), key) == (low,) * 3
            assert getattr(LutParams(**{key: [high + 1] * 3}), key) == (high,) * 3
        else:
            assert getattr(LutParams(**{key: low - 1}), key) == low
            assert getattr(LutParams(**{key: high + 1}), key) == high
