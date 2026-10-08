"""判定层测试。

两条策略并用:

1. **边界测试**:用 `dataclasses.replace` 构造贴阈值的 PhotoStats,断言「刚好不触发 / 刚好触发」。
   这样改阈值时,失败信息能直接告诉你是哪条规则受影响。
2. **fixture 测试**:用合成缺陷图验证真实输入能被正确检出(防止「阈值对但指标算错」)。
"""
import dataclasses

import pytest

from photo import quality as Q
from photo.fixtures import ALL_KINDS, make_fixture
from photo.stats import analyze
from photo.types import PhotoStats

# 一个「完全正常」的基准:所有指标都在安全区,便于单变量改写
BASE = PhotoStats(
    width=480, height=360, sampled_px=172800,
    lum_p1=0.08, lum_p5=0.10, lum_p50=0.40, lum_p95=0.65, lum_p99=0.80,
    highlight_clip_pct=0.0, shadow_clip_pct=0.0,
    rgb_mean=(0.30, 0.31, 0.31), rgb_median=(0.30, 0.31, 0.31),
    shadow_cast=(0.10, 0.10, 0.10), highlight_cast=(0.60, 0.62, 0.62),
    gray_world_dev=0.01,
    saturation_mean=0.25, saturation_p95=0.45,
    skin_ratio=0.0, skin_mean_rgb=None, skin_lum_p50=None,
    noise_sigma=0.005,
)


def codes(**kw):
    """改写 BASE 的若干字段后取诊断结果。"""
    return [i.code for i in Q.diagnose(dataclasses.replace(BASE, **kw))]


def test_base_has_no_issues():
    """基准必须干净 —— 否则后面的单变量断言都在验证一个已经有问题的起点。"""
    assert codes() == []


# ---------------- 欠曝 / 过曝 ----------------

def test_under_exposed_boundary():
    assert "under_exposed" not in codes(lum_p50=Q.UNDER_EXPOSED_MEDIAN)
    assert "under_exposed" in codes(lum_p50=Q.UNDER_EXPOSED_MEDIAN - 0.001)


def test_over_exposed_boundary():
    assert "over_exposed" not in codes(lum_p50=Q.OVER_EXPOSED_MEDIAN)
    assert "over_exposed" in codes(lum_p50=Q.OVER_EXPOSED_MEDIAN + 0.001)


def test_exposure_issues_are_mutually_exclusive():
    """不能同时报欠曝与过曝。"""
    assert not ({"under_exposed", "over_exposed"} <= set(codes(lum_p50=0.25)))


# ---------------- 对比度 / 灰雾 ----------------

def test_low_contrast_boundary():
    rng = Q.LOW_CONTRAST_RANGE
    # 用「中调离灰雾中心较远」的起点,避免同时命中 flat_haze 干扰判断
    far = 0.62
    assert "low_contrast" not in codes(lum_p50=far, lum_p5=0.10, lum_p95=0.10 + rng)
    assert "low_contrast" in codes(lum_p50=far, lum_p5=0.10, lum_p95=0.10 + rng - 0.001)


def test_flat_haze_requires_both_conditions():
    """灰雾 = 中调偏灰 **且** 区间窄。只满足一个不算。"""
    narrow = Q.FLAT_HAZE_RANGE - 0.02
    assert "flat_haze" in codes(lum_p50=Q.FLAT_HAZE_MEDIAN, lum_p5=0.20, lum_p95=0.20 + narrow)
    # 区间窄但中调明显偏暗 → 是欠曝/低对比,不是灰雾
    assert "flat_haze" not in codes(lum_p50=0.20, lum_p5=0.15, lum_p95=0.15 + narrow)


def test_low_contrast_and_flat_haze_not_both_reported():
    """低对比是灰雾的子集情况,不应重复报两条。"""
    got = codes(lum_p50=Q.FLAT_HAZE_MEDIAN, lum_p5=0.20, lum_p95=0.25)
    assert "flat_haze" in got
    assert "low_contrast" not in got


# ---------------- 色偏 ----------------

def test_warm_cast_boundary_and_direction():
    got = codes(rgb_mean=(0.40, 0.31, 0.24), gray_world_dev=0.15)
    assert "color_cast_warm" in got
    issue = next(i for i in Q.diagnose(dataclasses.replace(BASE, rgb_mean=(0.40, 0.31, 0.24), gray_world_dev=0.15))
                 if i.code == "color_cast_warm")
    # 偏暖 → 需要降温,所以建议的 temp 必须为负
    assert issue.suggested["temp"] < 0, "偏暖的修正方向应为负色温(降温)"


def test_cool_cast_direction():
    issues = Q.diagnose(dataclasses.replace(BASE, rgb_mean=(0.24, 0.31, 0.40), gray_world_dev=0.15))
    issue = next(i for i in issues if i.code == "color_cast_cool")
    assert issue.suggested["temp"] > 0, "偏冷的修正方向应为正色温(升温)"


def test_cast_requires_both_magnitude_and_gray_world():
    """光有通道差不够,还要灰世界偏差达标 —— 避免把「有色彩的题材」当成色偏。"""
    assert "color_cast_warm" not in codes(rgb_mean=(0.40, 0.31, 0.24), gray_world_dev=0.001)
    assert "color_cast_warm" not in codes(
        rgb_mean=(0.305, 0.31, 0.30), gray_world_dev=0.5,
        # B−R 只有 -0.005,低于 CAST_MIN_GLOBAL
    )


def test_shadow_cast_boundary():
    just_under = Q.SHADOW_CAST_WARN - 0.002      # 留出浮点余量
    assert "shadow_cast" not in codes(shadow_cast=(0.10, 0.10, 0.10 + just_under))
    got = codes(shadow_cast=(0.10, 0.10, 0.10 + Q.SHADOW_CAST_WARN + 0.01))
    assert "shadow_cast" in got


def test_shadow_cast_direction():
    blue = next(i for i in Q.diagnose(dataclasses.replace(BASE, shadow_cast=(0.05, 0.10, 0.25)))
                if i.code == "shadow_cast")
    yellow = next(i for i in Q.diagnose(dataclasses.replace(BASE, shadow_cast=(0.25, 0.10, 0.05)))
                  if i.code == "shadow_cast")
    # 暗部偏蓝 → lift 的 B 通道为正(抬蓝以外?实为压 B/抬 R)
    assert blue.suggested["lift"][2] > 0, "暗部偏蓝应抬 B 或压 R 以中和"
    assert yellow.suggested["lift"][0] > 0


# ---------------- 饱和度 ----------------

def test_over_saturated_triggers_on_mean_or_p95():
    assert "over_saturated" not in codes(
        saturation_mean=Q.OVER_SATURATED_MEAN, saturation_p95=Q.OVER_SATURATED_P95)
    assert "over_saturated" in codes(saturation_mean=Q.OVER_SATURATED_MEAN + 0.01)
    assert "over_saturated" in codes(saturation_p95=Q.OVER_SATURATED_P95 + 0.01)


def test_over_saturated_suggests_reduction():
    issue = next(i for i in Q.diagnose(dataclasses.replace(BASE, saturation_mean=0.60))
                 if i.code == "over_saturated")
    assert issue.suggested["saturation"] < 0


# ---------------- 裁剪 ----------------

def test_highlight_clipping_boundary():
    assert "highlight_clipping" not in codes(highlight_clip_pct=Q.CLIP_WARN_PCT)
    assert "highlight_clipping" in codes(highlight_clip_pct=Q.CLIP_WARN_PCT + 0.1)


def test_shadow_crushed_boundary():
    assert "shadow_crushed" not in codes(shadow_clip_pct=Q.CLIP_WARN_PCT)
    assert "shadow_crushed" in codes(shadow_clip_pct=Q.CLIP_WARN_PCT + 0.1)


# ---------------- 排序与证据文案 ----------------

def test_issues_sorted_by_severity_desc():
    issues = Q.diagnose(dataclasses.replace(
        BASE, lum_p50=0.15, saturation_mean=0.55, highlight_clip_pct=2.0))
    sevs = [i.severity for i in issues]
    assert sevs == sorted(sevs, reverse=True)
    assert len(issues) >= 3


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_evidence_is_human_readable(kind):
    """evidence 会原样出现在 UI 里 —— 必须是给人看的证据句,不能是代码腔。"""
    for issue in Q.diagnose(analyze(make_fixture(kind))):
        assert len(issue.evidence) >= 8, f"{issue.code} 的证据句过短:{issue.evidence}"
        assert any(ch.isdigit() for ch in issue.evidence), \
            f"{issue.code} 的证据句没有具体数值:{issue.evidence}"
        # 不应出现纯 ASCII 变量名风格
        assert not issue.evidence.startswith("lum_")
        assert "None" not in issue.evidence


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_severity_in_range(kind):
    for issue in Q.diagnose(analyze(make_fixture(kind))):
        assert 0.0 <= issue.severity <= 1.0, f"{issue.code} severity 越界"


# ---------------- fixture 检出对照 ----------------

EXPECTED = {
    "neutral": set(),
    "under_exposed": {"under_exposed"},
    "over_exposed": {"over_exposed"},
    "low_contrast": {"low_contrast"},
    "flat_haze": {"flat_haze"},
    "warm_cast": {"color_cast_warm"},
    "cool_cast": {"color_cast_cool"},
    "shadow_blue": {"shadow_cast"},
    "over_saturated": {"over_saturated"},
    "highlight_clip": {"highlight_clipping"},
    "skin_tone": set(),
    "skin_dark": set(),
    "noisy": {"over_saturated"},
}


@pytest.mark.parametrize("kind", sorted(EXPECTED))
def test_expected_issue_detected_for_fixture(kind):
    """每个 fixture 至少要检出它对应的那个问题。"""
    got = {i.code for i in Q.diagnose(analyze(make_fixture(kind)))}
    missing = EXPECTED[kind] - got
    assert not missing, f"{kind} 未检出 {missing},实际检出 {got}"


# ---------------- limits_for ----------------

def test_limits_default_when_clean():
    lim = Q.limits_for(BASE)
    assert lim["max_contrast_delta"] == 1.0
    assert lim["max_saturation_delta"] == 1.0


def test_limits_tighten_on_noisy_image():
    noisy = dataclasses.replace(BASE, noise_sigma=Q.NOISE_SIGMA_WARN + 0.05)
    lim = Q.limits_for(noisy)
    assert lim["max_contrast_delta"] < 1.0
    assert lim["max_saturation_delta"] < 1.0


def test_limits_tighten_monotonically_with_noise():
    """噪点越重,允许的增幅越小 —— 单调性防止阈值写反。"""
    prev_c, prev_s = 2.0, 2.0
    for sigma in (0.030, 0.040, 0.050, 0.080):
        lim = Q.limits_for(dataclasses.replace(BASE, noise_sigma=sigma))
        assert lim["max_contrast_delta"] <= prev_c
        assert lim["max_saturation_delta"] <= prev_s
        prev_c, prev_s = lim["max_contrast_delta"], lim["max_saturation_delta"]


def test_limits_stay_positive():
    very_noisy = dataclasses.replace(BASE, noise_sigma=1.0)
    lim = Q.limits_for(very_noisy)
    assert lim["max_contrast_delta"] > 0
    assert lim["max_saturation_delta"] > 0


# ---------------- is_converged ----------------

def test_is_converged_true_for_clean():
    assert Q.is_converged(BASE) is True


def test_is_converged_false_when_issue_present():
    assert Q.is_converged(dataclasses.replace(BASE, lum_p50=0.20)) is False


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_is_converged_matches_diagnose(kind):
    """收敛判定必须与诊断严格一致 —— 否则会在还有问题时提前结束迭代。"""
    s = analyze(make_fixture(kind))
    assert Q.is_converged(s) == (len(Q.diagnose(s)) == 0)


# ---------------- 阈值自洽 ----------------

def test_exposure_target_between_thresholds():
    """建议落点必须落在「不算欠曝也不算过曝」的区间内,否则保守解会自我矛盾。"""
    lo, hi = Q.EXPOSURE_TARGET
    assert Q.UNDER_EXPOSED_MEDIAN <= lo < hi <= Q.OVER_EXPOSED_MEDIAN


def test_clip_severe_above_warn():
    assert Q.CLIP_SEVERE_PCT > Q.CLIP_WARN_PCT


def test_flat_haze_is_a_stricter_subset_of_low_contrast():
    """灰雾必须是低对比的子集:区间条件更严。

    这条断言锁住一个真实修过的 bug:FLAT_HAZE_RANGE 曾写成 0.38 > 0.30,
    导致一张「中等对比」的图被判成灰雾,而真正的低对比反而报不出来。
    """
    assert Q.FLAT_HAZE_RANGE < Q.LOW_CONTRAST_RANGE, \
        f"灰雾阈值 {Q.FLAT_HAZE_RANGE} 不应宽于低对比阈值 {Q.LOW_CONTRAST_RANGE}"


def test_medium_contrast_is_low_contrast_not_haze():
    """区间落在两个阈值之间时应报 low_contrast,不能报 flat_haze。"""
    mid = (Q.FLAT_HAZE_RANGE + Q.LOW_CONTRAST_RANGE) / 2
    got = codes(lum_p50=0.42, lum_p5=0.20, lum_p95=0.20 + mid)
    assert "flat_haze" not in got, f"中等对比被误判为灰雾:{got}"
