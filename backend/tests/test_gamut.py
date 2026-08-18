import numpy as np

from lut_engine.params import LutParams
from lut_engine.lut3d import generate_lut
from lut_engine.transforms import apply_contrast, gamut_clamp
from lut_engine.vlog import tone_map_aces


def test_params_clamp():
    p = LutParams(contrast=5, saturation=-3, hue=500, temp=9999, tone_map=5)
    assert p.contrast == 1.0
    assert p.saturation == -1.0
    assert p.hue == 180.0
    assert p.temp == 3000.0
    assert p.tone_map == 1.0


def test_contrast_pivot_midgray():
    x = np.array([[0.462, 0.462, 0.462]])
    assert np.allclose(apply_contrast(x, 0.5), x, atol=1e-6)


def test_gamut_clamp_range():
    rgb = np.array([[1.5, 0.2, -0.3]])
    out = gamut_clamp(rgb)
    assert out.min() >= 0.0
    assert out.max() <= 1.0


def test_gamut_clamp_gray_unchanged():
    gray = np.array([[0.5, 0.5, 0.5]])
    assert np.allclose(gamut_clamp(gray), gray, atol=1e-6)


def test_hue_extreme_in_gamut():
    lut = generate_lut(LutParams(hue=180.0), size=17)
    assert lut.min() >= 0.0
    assert lut.max() <= 1.0


def test_tone_map_strength():
    x = np.array([2.0])
    full = tone_map_aces(x, 1.0)
    none = tone_map_aces(x, 0.0)
    assert np.allclose(none, x, atol=1e-6)
    assert full[0] < x[0]
    mid = tone_map_aces(x, 0.5)
    assert np.allclose(mid, (full + none) / 2, atol=1e-6)
