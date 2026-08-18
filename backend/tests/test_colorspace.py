import numpy as np

from lut_engine.colorspace import (
    srgb_eotf,
    srgb_oetf,
    rec709_eotf,
    rec709_oetf,
    white_balance_gain,
)


def test_srgb_roundtrip():
    x = np.linspace(0.0, 1.0, 1000)
    assert np.allclose(srgb_oetf(srgb_eotf(x)), x, atol=1e-6)


def test_rec709_roundtrip():
    # rec709 OETF 两段在阈值处有 ~0.0002 规范固有不连续,atol 放宽
    x = np.linspace(0.0, 1.0, 1000)
    assert np.allclose(rec709_oetf(rec709_eotf(x)), x, atol=2e-3)


def test_neutral_at_zero_offset():
    assert np.allclose(white_balance_gain(0.0, 0.0), 1.0, atol=1e-6)


def test_warm_offset():
    g = white_balance_gain(3000.0, 0.0)
    assert g[0] > g[2]  # 暖:R 增益 > B 增益


def test_cool_offset():
    g = white_balance_gain(-3000.0, 0.0)
    assert g[2] > g[0]  # 冷:B 增益 > R 增益


def test_gain_monotonic():
    ts = np.linspace(-2000.0, 2000.0, 9)
    gains = [white_balance_gain(t, 0.0) for t in ts]
    rs = [g[0] for g in gains]
    bs = [g[2] for g in gains]
    assert rs == sorted(rs)  # temp 升(暖)→ R 增益升
    assert bs == sorted(bs, reverse=True)  # temp 升 → B 增益降
