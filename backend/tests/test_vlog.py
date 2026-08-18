import numpy as np

from lut_engine.vlog import vlog_to_linear, vlog_to_rec709, V_GAMUT_TO_709


def test_black_point():
    assert abs(vlog_to_linear(np.array([0.125]))[0]) < 1e-6


def test_white_point_is_superwhite():
    # V-Log L=1 对应远超白点的线性值(约 46)
    assert vlog_to_linear(np.array([1.0]))[0] > 1.0


def test_monotonic_increasing():
    x = np.linspace(0.125, 1.0, 1000)
    lin = vlog_to_linear(x)
    assert np.all(np.diff(lin) > 0)


def test_matrix_preserves_gray():
    # 矩阵行和 ≈ 1,中性灰不偏移
    assert np.allclose(V_GAMUT_TO_709.sum(axis=1), 1.0, atol=1e-5)


def test_output_in_unit_range():
    rgb = np.random.rand(33 * 33 * 33, 3)
    out = vlog_to_rec709(rgb)
    assert out.min() >= 0.0
    assert out.max() <= 1.0


def test_gray_stays_gray():
    # 中性灰 V-Log 输入,转换后 R=G=B
    gray = np.full((100, 3), 0.4)
    out = vlog_to_rec709(gray)
    assert np.allclose(out[:, 0], out[:, 1], atol=1e-6)
    assert np.allclose(out[:, 1], out[:, 2], atol=1e-6)


def test_vlog_identity_lut():
    # 恒等风格 + VLOG 基准 → 输出 = vlog_to_rec709(网格)
    from lut_engine.lut3d import generate_lut, build_grid
    from lut_engine.params import LutParams

    lut = generate_lut(LutParams(base_photo_style="VLOG"), size=17)
    grid = build_grid(17)
    expected = vlog_to_rec709(grid.reshape(-1, 3)).reshape(17, 17, 17, 3)
    assert np.allclose(lut, expected, atol=1e-6)
