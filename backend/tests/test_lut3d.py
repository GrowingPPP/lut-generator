import numpy as np

from lut_engine.params import LutParams
from lut_engine.lut3d import generate_lut, build_grid
from lut_engine import colorspace

SIZE = 17


def test_identity():
    lut = generate_lut(LutParams(), size=SIZE)
    assert np.allclose(lut, build_grid(SIZE), atol=1e-6)


def test_exposure_doubles_linear():
    # 曝光 +1 EV 在线性域翻倍,再回编码(clamp 到 [0,1])
    lut = generate_lut(LutParams(exposure=1.0), size=SIZE)
    grid = build_grid(SIZE)
    expected = np.clip(colorspace.srgb_oetf(colorspace.srgb_eotf(grid) * 2.0), 0.0, 1.0)
    assert np.allclose(lut, expected, atol=1e-6)


def test_saturation_minus_one_is_grayscale():
    lut = generate_lut(LutParams(saturation=-1.0), size=SIZE)
    r, g, b = lut[..., 0], lut[..., 1], lut[..., 2]
    assert np.allclose(r, g, atol=1e-6)
    assert np.allclose(g, b, atol=1e-6)


def test_contrast_zero_identity():
    lut = generate_lut(LutParams(contrast=0.0), size=SIZE)
    assert np.allclose(lut, build_grid(SIZE), atol=1e-6)


def test_hue_zero_identity():
    lut = generate_lut(LutParams(hue=0.0), size=SIZE)
    assert np.allclose(lut, build_grid(SIZE), atol=1e-6)


def test_output_in_unit_range():
    params = LutParams(
        temp=2000.0, tint=-500.0, exposure=1.5, contrast=0.6,
        saturation=0.4, hue=45.0, vibrance=0.3,
        lift=(0.1, 0.0, 0.0), gamma=(0.8, 1.0, 1.2), gain=(1.1, 1.0, 1.0),
    )
    lut = generate_lut(params, size=SIZE)
    assert lut.min() >= 0.0
    assert lut.max() <= 1.0


def test_shape_33():
    lut = generate_lut(LutParams(), size=33)
    assert lut.shape == (33, 33, 33, 3)
