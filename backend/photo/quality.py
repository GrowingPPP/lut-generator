"""客观测量 → 问题清单 + 硬校验上限。

为什么要有这一层(而不是把原始数字直接丢给模型):

1. **阈值可测、可调、可回归** —— 纯函数,改一个数字就知道影响面
2. **省 token** —— 只传命中的问题,而不是几十个原始数字
3. **可解释** —— `Issue.evidence` 直接变成给用户看的说明,一份文案同时服务模型与人

阈值全部集中在本模块顶部,每个都有边界测试(`test_photo_quality.py`)。
"""
from typing import Dict, List

from .types import Issue, PhotoStats

# ---- 亮度 ----
UNDER_EXPOSED_MEDIAN = 0.32      # lum_p50 低于此 → 欠曝
OVER_EXPOSED_MEDIAN = 0.68       # lum_p50 高于此 → 过曝
LOW_CONTRAST_RANGE = 0.30        # (p95-p5) 小于此 → 低对比
FLAT_HAZE_MEDIAN = 0.42          # 中调偏灰且区间窄 → 灰雾
# 必须 <= LOW_CONTRAST_RANGE:灰雾是低对比的**子集**,条件比它更严才讲得通。
# (曾写成 0.38 > 0.30,结果一张中等对比的图会被判成「灰雾」而不是「低对比」。)
FLAT_HAZE_RANGE = 0.28
EXPOSURE_TARGET = (0.40, 0.55)   # 建议的 p50 落点,保守解用它算曝光修正

# ---- 裁剪 ----
CLIP_WARN_PCT = 1.5
CLIP_SEVERE_PCT = 4.0

# ---- 色偏 ----
GRAY_WORLD_WARN = 0.06
SHADOW_CAST_WARN = 0.05          # 暗部通道相对差(B−R)
CAST_MIN_GLOBAL = 0.03           # 全局 B−R 低于此不算「整体色偏」

# ---- 饱和度 ----
# 阈值由 fixture 实测校准(见 test_photo_quality.py 的校准表):
#   中性 0.217/0.370 · 肤色 0.139/0.333 · 过曝 0.151/0.323 · 噪点 0.302/0.826
#   暖调 0.383/0.549 · 冷调 0.409/0.547 · 过饱和 0.436/0.682
# mean 单独不可靠:画面构成会把它带偏(噪点图的 mean 仅 0.302 却明显过饱和,
# 因为噪声逐通道独立叠加会抬高局部饱和)。p95 更能代表「最艳的那部分」。
OVER_SATURATED_MEAN = 0.42
OVER_SATURATED_P95 = 0.78

# ---- 画质 ----
NOISE_SIGMA_WARN = 0.030         # 超过则收紧 contrast/saturation 上限

# ---- 硬校验上限(供 agent/auto.py 的 check_hard_rules 使用)----
MAX_CLIP_INCREASE_PCT = 0.5      # 高光/阴影裁剪增幅上限
MAX_SKIN_SHIFT = 0.06            # 有肤色时,单通道漂移上限
MAX_SATURATION_GROWTH = 1.6      # 饱和度相对最初基线的倍率上限
MAX_EXPOSURE_STEP_EV = 1.0       # 单轮曝光调整上限
NOISY_MAX_CONTRAST_DELTA = 0.25  # 噪点高时的对比度增幅上限
NOISY_MAX_SATURATION_DELTA = 0.20


def _sev(value: float, lo: float, hi: float) -> float:
    """把「偏离程度」映射到 0..1 的严重度。lo=刚好触发,hi=饱和。"""
    if hi <= lo:
        return 1.0
    return float(max(0.0, min(1.0, (value - lo) / (hi - lo))))


def diagnose(stats: PhotoStats) -> List[Issue]:
    """产出问题清单,顺序即 UI 展示顺序。

    evidence 必须是**可读的证据句**(会原样出现在 UI 的「修改说明」里),
    不要写成 "p50 too low" 这种代码腔。
    """
    out: List[Issue] = []
    lum_range = stats.lum_p95 - stats.lum_p5

    # 1. 欠曝 / 过曝
    if stats.lum_p50 < UNDER_EXPOSED_MEDIAN:
        out.append(Issue(
            code="under_exposed",
            severity=_sev(UNDER_EXPOSED_MEDIAN - stats.lum_p50, 0.0, 0.20),
            evidence=f"中间调偏暗(lum_p50={stats.lum_p50:.3f},建议 {EXPOSURE_TARGET[0]:.2f}~{EXPOSURE_TARGET[1]:.2f})",
            suggested={"exposure": 0.4},
        ))
    elif stats.lum_p50 > OVER_EXPOSED_MEDIAN:
        out.append(Issue(
            code="over_exposed",
            severity=_sev(stats.lum_p50 - OVER_EXPOSED_MEDIAN, 0.0, 0.20),
            evidence=f"中间调偏亮(lum_p50={stats.lum_p50:.3f},建议 {EXPOSURE_TARGET[0]:.2f}~{EXPOSURE_TARGET[1]:.2f})",
            suggested={"exposure": -0.4},
        ))

    # 2. 灰雾(比低对比更具体:中调偏灰 + 区间窄)
    is_haze = (
        abs(stats.lum_p50 - FLAT_HAZE_MEDIAN) <= 0.10
        and lum_range < FLAT_HAZE_RANGE
    )
    # 3. 低对比(灰雾的子集情况不重复报)
    if is_haze:
        out.append(Issue(
            code="flat_haze",
            severity=_sev(FLAT_HAZE_RANGE - lum_range, 0.0, 0.25),
            evidence=f"画面发灰(中间调 {stats.lum_p50:.3f} 且动态范围仅 {lum_range:.3f})",
            suggested={"contrast": 0.35, "blacks": 0.10},
        ))
    elif lum_range < LOW_CONTRAST_RANGE:
        out.append(Issue(
            code="low_contrast",
            severity=_sev(LOW_CONTRAST_RANGE - lum_range, 0.0, 0.20),
            evidence=f"动态范围偏窄(p95−p5={lum_range:.3f},建议 ≥{LOW_CONTRAST_RANGE:.2f})",
            suggested={"contrast": 0.3},
        ))

    # 4. 整体色偏(B−R:正=偏冷,负=偏暖)
    b_minus_r = stats.rgb_mean[2] - stats.rgb_mean[0]
    if abs(b_minus_r) >= CAST_MIN_GLOBAL and stats.gray_world_dev > GRAY_WORLD_WARN:
        warm = b_minus_r < 0
        out.append(Issue(
            code="color_cast_warm" if warm else "color_cast_cool",
            severity=_sev(abs(b_minus_r), CAST_MIN_GLOBAL, 0.20),
            evidence=(
                f"整体偏{'暖' if warm else '冷'}"
                f"(B−R={b_minus_r:+.3f},灰世界偏差 {stats.gray_world_dev:.3f})"
            ),
            # 偏暖 → 需要降温(负 temp);偏冷 → 升温
            suggested={"temp": -500.0 if warm else 500.0},
        ))

    # 5. 暗部色偏(全局可能中性,但暗部偏色 —— 这是白平衡问题而非光线氛围)
    shadow_cast = stats.shadow_cast[2] - stats.shadow_cast[0]
    if abs(shadow_cast) > SHADOW_CAST_WARN:
        out.append(Issue(
            code="shadow_cast",
            severity=_sev(abs(shadow_cast), SHADOW_CAST_WARN, 0.20),
            evidence=f"暗部偏{'蓝' if shadow_cast > 0 else '黄'}(暗部 B−R={shadow_cast:+.3f})",
            suggested={"lift": [-0.01, 0.0, 0.02] if shadow_cast > 0 else [0.01, 0.0, -0.02]},
        ))

    # 6. 过饱和
    if stats.saturation_mean > OVER_SATURATED_MEAN or stats.saturation_p95 > OVER_SATURATED_P95:
        out.append(Issue(
            code="over_saturated",
            severity=max(
                _sev(stats.saturation_mean, OVER_SATURATED_MEAN, 0.65),
                _sev(stats.saturation_p95, OVER_SATURATED_P95, 0.95),
            ),
            evidence=(
                f"饱和度偏高(均值 {stats.saturation_mean:.3f},P95 {stats.saturation_p95:.3f})"
            ),
            suggested={"saturation": -0.2, "vibrance": -0.15},
        ))

    # 7. 裁剪(分别报,因为修法不同)
    if stats.highlight_clip_pct > CLIP_WARN_PCT:
        out.append(Issue(
            code="highlight_clipping",
            severity=_sev(stats.highlight_clip_pct, CLIP_WARN_PCT, CLIP_SEVERE_PCT * 2),
            evidence=f"高光溢出 {stats.highlight_clip_pct:.2f}%,亮部细节已丢失",
            suggested={"highlights": -0.4, "whites": -0.10},
        ))
    if stats.shadow_clip_pct > CLIP_WARN_PCT:
        out.append(Issue(
            code="shadow_crushed",
            severity=_sev(stats.shadow_clip_pct, CLIP_WARN_PCT, CLIP_SEVERE_PCT * 2),
            evidence=f"暗部压死 {stats.shadow_clip_pct:.2f}%,阴影细节已丢失",
            suggested={"shadows": 0.4, "blacks": 0.10},
        ))

    # 严重度高的排前面,便于 UI 与提示词都先关注主要问题
    out.sort(key=lambda i: -i.severity)
    return out


def limits_for(stats: PhotoStats) -> Dict[str, float]:
    """由画质推导出的硬校验上限。噪点高时收紧,避免把噪点一起放大。"""
    limits = {
        "max_contrast_delta": 1.0,
        "max_saturation_delta": 1.0,
    }
    if stats.noise_sigma > NOISE_SIGMA_WARN:
        # 噪点越重,允许的对比度/饱和度增幅越小
        excess = min(1.0, (stats.noise_sigma - NOISE_SIGMA_WARN) / 0.05)
        limits["max_contrast_delta"] = (
            NOISY_MAX_CONTRAST_DELTA + (1.0 - NOISY_MAX_CONTRAST_DELTA) * (1.0 - excess)
        )
        limits["max_saturation_delta"] = (
            NOISY_MAX_SATURATION_DELTA + (1.0 - NOISY_MAX_SATURATION_DELTA) * (1.0 - excess)
        )
    return limits


def is_converged(stats: PhotoStats) -> bool:
    """所有已诊断问题是否都已缓解到阈值内。用于提前结束,省一轮 LLM 调用。"""
    return len(diagnose(stats)) == 0
