"""参数契约测试:dict→LutParams 工厂的 clamp/字段保留,以及 tone_map 在 agent 生成路径不丢失。"""
import pytest

from agent.graph import run_agent
from lut_engine import LutParams, lut_params_from_dict, generate_lut, lut_to_cube


def test_invalid_base_photo_style_raises():
    with pytest.raises(ValueError):
        LutParams(base_photo_style="XYZ")


def test_factory_preserves_tone_map():
    p = lut_params_from_dict({"base_photo_style": "VLOG", "tone_map": 0.3})
    assert p.base_photo_style == "VLOG"
    assert p.tone_map == 0.3


def test_factory_clamps_out_of_range():
    p = lut_params_from_dict({"tint": 800.0, "exposure": 5.0, "temp": -9999.0})
    assert p.tint == 500.0
    assert p.exposure == 3.0
    assert p.temp == -3000.0


def test_factory_ignores_unknown_keys():
    p = lut_params_from_dict({"foo": 1, "bar": "x", "contrast": 0.2})
    assert p.contrast == 0.2
    assert not hasattr(p, "foo")


def test_factory_accepts_list_for_rgb():
    p = lut_params_from_dict({"lift": [0.01, 0.02, 0.03]})
    assert p.lift == (0.01, 0.02, 0.03)


def test_agent_generate_propagates_tone_map():
    """confirm 且带 tone_map 的 V-Log 参数,生成的 cube 必须与 tone_map=0.5 的手工结果一致。"""
    result = run_agent(
        lambda msg: {"intent": "confirm"},
        "确认",
        params={"base_photo_style": "VLOG", "tone_map": 0.5},
    )
    assert result["done"] is True

    expected = generate_lut(
        lut_params_from_dict({"base_photo_style": "VLOG", "tone_map": 0.5}), size=33
    )
    assert result["cube_text"] == lut_to_cube(expected, title="generated", photo_style="VLOG")
