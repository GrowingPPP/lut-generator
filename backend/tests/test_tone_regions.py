"""影调分区与分离色调(逐点新算子)的测试。

三组关注点:
  1. 中性默认 → 精确恒等(否则会静默改变所有已保存 LUT)
  2. 各算子方向正确(压高光就该让亮点变暗,提阴影就该让暗点变亮)
  3. 33³ 网格的表达精度不退化(有实测包络,防止有人放松滑杆范围)
"""
import numpy as np
import pytest

from lut_engine import build_grid, generate_lut, lut_params_from_dict
from lut_engine.params import LutParams
from lut_engine import transforms

NEUTRAL = {}


def _lut(**kw) -> np.ndarray:
    return generate_lut(lut_params_from_dict(kw), 33)


# ---- 1. 恒等性 ----

def test_default_params_are_exact_identity():
    """默认参数必须精确恒等 —— 这是已保存 LUT 不被静默改变的前提。"""
    err = np.abs(_lut() - build_grid(33)).max()
    assert err < 1e-12, f"默认参数不是恒等,最大偏差 {err}"


@pytest.mark.parametrize("key", [
    "highlights", "shadows", "whites", "blacks", "curve",
    "split_shadow_sat", "split_highlight_sat",
])
def test_neutral_value_of_each_new_param_is_identity(key):
    """每个新参数取中性值时不能产生任何改变。"""
    err = np.abs(_lut(**{key: 0.0}) - build_grid(33)).max()
    assert err < 1e-12, f"{key}=0 仍改变了输出,最大偏差 {err}"


@pytest.mark.parametrize("key,value", [
    ("highlights", -0.6), ("highlights", 0.6), ("shadows", 0.6), ("shadows", -0.6),
    ("whites", 0.15), ("whites", -0.15), ("blacks", 0.15), ("blacks", -0.15),
    ("curve", 0.5), ("curve", -0.5),
    ("split_shadow_sat", 0.6), ("split_highlight_sat", 0.6),
])
def test_each_new_param_actually_does_something(key, value):
    """反向断言:不能让某个算子变成空实现还蒙混过关。"""
    delta = np.abs(_lut(**{key: value}) - build_grid(33)).max()
    assert delta > 0.01, f"{key}={value} 几乎没效果(最大改变 {delta})"


# ---- 2. 方向正确性 ----

def _gray(level):
    return np.array([[[level, level, level]]], np.float32)


def test_highlights_negative_darkens_brights_only():
    """负值压高光:亮点变暗,暗点基本不动。"""
    dark = transforms.apply_highlights(_gray(0.15), -0.8)[0, 0]
    bright = transforms.apply_highlights(_gray(0.90), -0.8)[0, 0]
    assert bright.mean() < 0.90 - 0.02, "压高光没有压暗亮点"
    assert abs(dark.mean() - 0.15) < 0.01, "压高光误伤了暗部"


def test_highlights_positive_brightens_brights():
    bright = transforms.apply_highlights(_gray(0.85), 0.8)[0, 0]
    assert bright.mean() > 0.85 + 0.01


def test_shadows_positive_lifts_darks_only():
    """正值提阴影:暗点变亮,亮点基本不动。"""
    dark = transforms.apply_shadows(_gray(0.12), 0.8)[0, 0]
    bright = transforms.apply_shadows(_gray(0.88), 0.8)[0, 0]
    assert dark.mean() > 0.12 + 0.02, "提阴影没有提亮暗部"
    assert abs(bright.mean() - 0.88) < 0.01, "提阴影误伤了亮部"


def test_whites_positive_lifts_toward_white():
    assert transforms.apply_whites(_gray(0.8), 0.2)[0, 0].mean() > 0.8


def test_blacks_positive_lifts_dead_black():
    """抬黑用于去死黑(胶片感),纯黑应被抬起来。"""
    assert transforms.apply_blacks(_gray(0.0), 0.2)[0, 0].mean() > 0.05


def test_curve_positive_increases_contrast():
    """S 曲线:提亮亮部同时压暗暗部 = 对比增强。"""
    dark = transforms.apply_curve(_gray(0.25), 0.8)[0, 0].mean()
    bright = transforms.apply_curve(_gray(0.75), 0.8)[0, 0].mean()
    assert dark < 0.25, "S 曲线没有压暗暗部"
    assert bright > 0.75, "S 曲线没有提亮亮部"


def test_split_tone_shadow_only_touches_darks():
    p = {"split_shadow_hue": 240.0, "split_shadow_sat": 0.8}
    out = generate_lut(lut_params_from_dict(p), 33)
    dark_idx, bright_idx = (3, 16, 16), (29, 16, 16)
    dark_delta = np.abs(out[dark_idx] - build_grid(33)[dark_idx]).max()
    bright_delta = np.abs(out[bright_idx] - build_grid(33)[bright_idx]).max()
    assert dark_delta > 0.01, "阴影染色没有作用于暗部"
    assert bright_delta < dark_delta * 0.5, "阴影染色不应主要作用于亮部"


def test_split_balance_shifts_influence():
    """balance 越大,高光染色范围越广 → 中调被高光色影响更多。"""
    mid = _gray(0.55)
    p_low = {"split_highlight_hue": 30.0, "split_highlight_sat": 0.8, "split_balance": 0.2}
    p_high = {"split_highlight_hue": 30.0, "split_highlight_sat": 0.8, "split_balance": 0.8}
    d_low = np.abs(transforms.apply_split_tone(mid, 0, 0, 30.0, 0.8, 0.2) - mid).max()
    d_high = np.abs(transforms.apply_split_tone(mid, 0, 0, 30.0, 0.8, 0.8) - mid).max()
    assert d_high > d_low, "balance 没有影响高光染色的覆盖范围"


def test_new_ops_output_stays_in_range():
    for params in ({"highlights": 1.0}, {"shadows": 1.0}, {"whites": 1.0},
                   {"blacks": 1.0}, {"curve": 1.0},
                   {"split_shadow_sat": 1.0, "split_highlight_sat": 1.0, "split_balance": 0.0}):
        lut = _lut(**params)
        assert lut.min() >= -1e-9 and lut.max() <= 1 + 1e-9, f"{params} 输出越界"


# ---- 3. 33³ 网格精度包络(防止有人放松范围后精度悄悄退化)----

def _interp_max_error(params, n=41) -> float:
    """33³ LUT 三线性重建 vs 更密网格直接求值,返回 8bit 级最大误差。"""
    lut = generate_lut(lut_params_from_dict(params), 33).astype(np.float32)
    dense = build_grid(n).reshape(-1, 3).astype(np.float32)
    truth = generate_lut(lut_params_from_dict(params), n).reshape(-1, 3)
    s = 32
    c = dense * s
    i0 = np.floor(c).astype(np.int32)
    i1 = np.minimum(i0 + 1, s)
    d = c - i0
    out = np.zeros_like(dense)
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                w = ((d[..., 0] if dx else 1 - d[..., 0]) *
                     (d[..., 1] if dy else 1 - d[..., 1]) *
                     (d[..., 2] if dz else 1 - d[..., 2]))
                idx = (np.minimum(i0[..., 0] + dx, s), np.minimum(i0[..., 1] + dy, s),
                       np.minimum(i0[..., 2] + dz, s))
                out += lut[idx] * w[..., None]
    return float((np.abs(out - truth).max(-1) * 255).max())


# 实测标定:33³ 网格在各类真实调色方案下的误差上限。
# 这些数字是产品约束,不是随手写的 —— 放宽任何滑杆范围前,先跑这些用例看是否退化。
GRADING_RECIPES = {
    "日系清透": ({"temp": 300, "contrast": -0.15, "saturation": -0.10,
                  "highlights": -0.2, "shadows": 0.25}, 1.0),
    "电影青橙": ({"temp": -200, "contrast": 0.15, "shadows": 0.3, "highlights": -0.4,
                  "split_shadow_hue": 210, "split_shadow_sat": 0.35,
                  "split_highlight_hue": 35, "split_highlight_sat": 0.3}, 4.0),
    "复古胶片": ({"temp": 400, "contrast": 0.10, "saturation": -0.20, "vibrance": 0.10,
                  "curve": -0.15, "blacks": 0.12}, 3.0),
    "风光提层次": ({"contrast": 0.25, "highlights": -0.5, "shadows": 0.5,
                    "whites": 0.08, "blacks": 0.10, "vibrance": 0.25}, 4.5),
    "人像柔和": ({"contrast": -0.1, "highlights": -0.3, "shadows": 0.35,
                  "saturation": -0.05, "vibrance": 0.15}, 3.0),
}


@pytest.mark.parametrize("name", list(GRADING_RECIPES))
def test_lattice_precision_within_measured_envelope(name):
    """真实调色方案下 33³ 网格误差必须留在实测包络内(肉眼不可见级别)。"""
    params, limit = GRADING_RECIPES[name]
    err = _interp_max_error(params)
    assert err <= limit, f"{name} 的 33³ 插值误差 {err:.2f}/255 超出标定上限 {limit}"


def test_over_stacked_grading_is_the_known_limit():
    """已知限制(记录,不是缺陷):contrast 与 saturation 同时很重时误差会上升。

    实测定位:主导误差的是既有的 contrast/saturation,而非本次新增的算子
    (逐个剔除时 highlights 对误差贡献为 0)。所以不靠收紧新参数范围来解决。
    若哪天要提升这块精度,只能把网格从 33³ 提到 65³ —— 但那会失去松下机内兼容。
    """
    heavy = {"contrast": 0.6, "saturation": 0.4, "highlights": -0.6, "shadows": 0.6,
             "whites": 0.2, "blacks": 0.2, "curve": 0.6,
             "split_shadow_sat": 0.5, "split_highlight_sat": 0.5}
    err = _interp_max_error(heavy)
    # 记录当前水平;若某天它显著变好或变坏,都应引起注意
    assert err < 20.0, f"重叠加时的误差 {err:.2f}/255 异常偏高,检查算子实现"


def test_new_params_contribute_little_error_in_isolation():
    """新增算子在单参数拉满时对网格友好(与 contrast/saturation 形成对比)。"""
    for key, value, limit in [
        ("highlights", -1.0, 1.5),
        ("curve", 1.0, 1.0),
        ("whites", 0.3, 2.5),
        ("blacks", 0.3, 2.5),
        ("shadows", 1.0, 4.5),
    ]:
        err = _interp_max_error({key: value})
        assert err <= limit, f"{key}={value} 的插值误差 {err:.2f}/255 超出 {limit}"


# ---- 4. 契约 ----

def test_new_fields_are_clamped():
    p = LutParams(highlights=5.0, shadows=-5.0, curve=9.0, split_shadow_sat=3.0,
                  split_balance=-1.0, split_shadow_hue=999.0)
    assert p.highlights == 1.0
    assert p.shadows == -1.0
    assert p.curve == 1.0
    assert p.split_shadow_sat == 1.0
    assert p.split_balance == 0.0
    assert p.split_shadow_hue == 360.0


def test_factory_accepts_new_fields():
    p = lut_params_from_dict({"highlights": -0.4, "shadows": 0.3, "split_shadow_sat": 0.2})
    assert (p.highlights, p.shadows, p.split_shadow_sat) == (-0.4, 0.3, 0.2)


def test_existing_op_order_unchanged():
    """原有 5 步算子的相对顺序不能变 —— 改了会让已保存 LUT 结果漂移。

    用「同样的参数,分别走完整链与手写链」比对来锁定顺序。
    """
    p = lut_params_from_dict({"contrast": 0.3, "gamma": [0.9, 1.0, 1.1],
                              "saturation": 0.2, "hue": 30.0, "vibrance": 0.2})
    sample = np.array([[0.35, 0.5, 0.65]], np.float32)
    manual = transforms.apply_contrast(sample, p.contrast)
    manual = transforms.apply_gamma(manual, p.gamma)
    manual = transforms.apply_saturation(manual, p.saturation)
    manual = transforms.apply_hue(manual, p.hue)
    manual = transforms.apply_vibrance(manual, p.vibrance)
    expected = np.clip(manual, 0, 1)
    got = transforms.apply_encoded_ops(sample, p)
    assert np.allclose(got, expected, atol=1e-7), "既有算子顺序被改动了"
