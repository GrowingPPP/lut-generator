"""LUT 参数的输出边界与技术转换契约。"""
from dataclasses import replace

import numpy as np
import pytest

from lut_engine import generate_lut
from lut_engine.params import LutParams
from lut_engine import transforms, vlog


@pytest.mark.parametrize("field,amount", [
    ("whites", -1.0), ("whites", 1.0),
    ("blacks", -1.0), ("blacks", 1.0),
    ("contrast", -1.0),
])
def test_tone_extremes_keep_gray_order(field, amount):
    lut = generate_lut(LutParams(**{field: amount}), size=33)
    gray = lut[np.arange(33), np.arange(33), np.arange(33), 0]
    assert np.diff(gray).min() >= -1e-9
    assert gray[-1] - gray[0] > 0.15


def test_whites_and_blacks_do_not_invert_endpoints():
    white_down = generate_lut(LutParams(whites=-1.0), size=33)
    black_up = generate_lut(LutParams(blacks=1.0), size=33)
    assert white_down[32, 32, 32, 0] >= 0.49
    assert black_up[0, 0, 0, 0] <= 0.51
    assert black_up[0, 0, 0, 0] < black_up[16, 16, 16, 0]


def test_zero_look_preserves_technical_correction_and_vlog_conversion():
    technical = LutParams(base_photo_style="VLOG", tone_map=0.7, exposure=0.4, temp=300)
    styled = replace(technical, look_strength=0.0, contrast=0.5,
                     split_shadow_hue=220, split_shadow_sat=0.5,
                     lift=(0.03, 0.0, -0.02))
    baseline = generate_lut(technical, size=17)
    zero_look = generate_lut(styled, size=17)
    assert np.allclose(zero_look, baseline, atol=1e-9)
    assert not np.allclose(baseline, generate_lut(LutParams(), size=17))


def test_half_look_interpolates_after_technical_conversion():
    p = LutParams(base_photo_style="VLOG", tone_map=0.5, exposure=0.3,
                  contrast=0.2, split_mid_hue=30, split_mid_sat=0.2)
    baseline = generate_lut(replace(p, look_strength=0.0), size=17)
    full = generate_lut(replace(p, look_strength=1.0), size=17)
    half = generate_lut(replace(p, look_strength=0.5), size=17)
    assert np.allclose(half, (baseline + full) / 2, atol=1e-9)


def test_vlog_exposure_runs_before_display_mapping():
    p = LutParams(base_photo_style="VLOG", exposure=0.5, tone_map=0.6)
    encoded = np.full((1, 3), 0.5)
    linear = vlog.vlog_decode_to_rec709_linear(encoded)
    expected = vlog.linear_to_rec709(vlog.tone_map_aces(
        transforms.apply_technical_ops(linear, p), p.tone_map))[0]
    actual = generate_lut(p, size=3)[1, 1, 1]
    assert np.allclose(actual, expected, atol=1e-9)


def test_selective_color_changes_target_hue_only():
    neutral = generate_lut(LutParams(), size=33)
    selective = generate_lut(LutParams(selective_hue_center=0,
                                       selective_hue_width=45,
                                       selective_hue_shift=30), size=33)
    assert np.abs(selective[24, 8, 8] - neutral[24, 8, 8]).max() > 0.01
    assert np.abs(selective[8, 8, 24] - neutral[8, 8, 24]).max() < 1e-9


def test_midtone_tint_fades_at_black_and_white():
    lut = generate_lut(LutParams(split_mid_hue=30, split_mid_sat=0.5), size=33)
    assert np.abs(lut[16, 16, 16] - 0.5).max() > 0.05
    assert np.allclose(lut[0, 0, 0], 0, atol=1e-9)
    assert np.allclose(lut[32, 32, 32], 1, atol=1e-9)
