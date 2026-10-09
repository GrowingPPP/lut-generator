"""测量层测试。

这一层是地基:测量算错了,上面所有断言都在验证一个错误的世界。
所以这里断言**具体数值**,而不是「不抛异常」。
"""
import numpy as np
import pytest
import io
from PIL import Image

from photo import stats as S
from photo.fixtures import ALL_KINDS, make_fixture, make_jpeg_bytes
from photo.types import CorruptImageError, ImageTooLargeError, PhotoStats


# ---- 确定性 ----

def test_analyze_is_deterministic():
    """同一输入必然同一输出 —— 这是后续所有回归的基础。"""
    img = make_fixture("neutral")
    assert S.analyze(img) == S.analyze(img)


def test_fixtures_are_deterministic():
    assert np.array_equal(make_fixture("noisy"), make_fixture("noisy"))


def test_large_photo_is_downsampled_before_float_rendering():
    source = Image.new("RGB", (2500, 1000), (80, 90, 100))
    data = io.BytesIO()
    source.save(data, format="JPEG")
    img = S.load_image(data.getvalue())
    assert max(img.shape[:2]) == S.MAX_RENDER_SIDE
    assert img.dtype == np.float32


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_stats_are_in_valid_range(kind):
    s = S.analyze(make_fixture(kind))
    assert 0.0 <= s.lum_p1 <= s.lum_p5 <= s.lum_p50 <= s.lum_p95 <= s.lum_p99 <= 1.0
    assert 0.0 <= s.highlight_clip_pct <= 100.0
    assert 0.0 <= s.shadow_clip_pct <= 100.0
    assert 0.0 <= s.saturation_mean <= 1.0
    assert 0.0 <= s.skin_ratio <= 1.0
    assert s.noise_sigma >= 0.0
    assert s.sampled_px > 0
    assert (s.width, s.height) == (480, 360)


# ---- 各缺陷的定向断言 ----

def test_under_exposed_measured_dark():
    s = S.analyze(make_fixture("under_exposed"))
    assert s.lum_p50 < 0.25, f"欠曝图的中调应明显偏低,实际 {s.lum_p50}"
    assert s.lum_p95 < 0.55


def test_over_exposed_measured_bright():
    s = S.analyze(make_fixture("over_exposed"))
    assert s.lum_p50 > 0.60
    assert s.highlight_clip_pct > 1.5, "过曝图应出现高光溢出"


def test_low_contrast_has_narrow_range():
    """range 需落在 FLAT_HAZE_RANGE(0.28) 与 LOW_CONTRAST_RANGE(0.30) 之间,
    这样它才能证明「低对比」这条规则、而不掉进更严的灰雾判定。"""
    from photo.quality import FLAT_HAZE_RANGE, LOW_CONTRAST_RANGE
    s = S.analyze(make_fixture("low_contrast"))
    rng = s.lum_p95 - s.lum_p5
    assert FLAT_HAZE_RANGE <= rng < LOW_CONTRAST_RANGE, f"实测 range={rng:.3f}"


def test_over_saturated_measured_high():
    s = S.analyze(make_fixture("over_saturated"))
    # 基底场景本身饱和度约 0.22,这张放大 2.6 倍后约 0.44
    assert s.saturation_mean > 0.40, f"实测 {s.saturation_mean:.3f}"


def test_highlight_clip_measured_with_correct_magnitude():
    s = S.analyze(make_fixture("highlight_clip"))
    # 顶部 30% 全白 → 至少 30% 溢出
    assert s.highlight_clip_pct > 25.0


def test_warm_cast_measured_with_correct_sign():
    """偏暖 = R 高于 B,所以 B−R 必须为负。符号写反会让修正方向反掉。"""
    s = S.analyze(make_fixture("warm_cast"))
    assert s.rgb_mean[2] - s.rgb_mean[0] < -0.02
    assert s.gray_world_dev > 0.02


def test_cool_cast_measured_with_correct_sign():
    s = S.analyze(make_fixture("cool_cast"))
    assert s.rgb_mean[2] - s.rgb_mean[0] > 0.10


def test_shadow_cast_isolates_dark_regions():
    """全局可能接近中性,但暗部偏蓝 —— 分段测量必须能抓到,否则白平衡诊断会漏。"""
    s = S.analyze(make_fixture("shadow_blue"))
    shadow_delta = s.shadow_cast[2] - s.shadow_cast[0]
    global_delta = s.rgb_mean[2] - s.rgb_mean[0]
    assert shadow_delta > 0.10, f"暗部 B−R 应明显为正,实际 {shadow_delta}"
    assert shadow_delta > global_delta * 1.3, "暗部色偏应比全局更明显"


def test_noise_estimate_tracks_injected_sigma():
    """噪点估计必须随注入量单调上升(不要求精确还原,要求方向正确)。"""
    quiet = S.analyze(make_fixture("neutral")).noise_sigma
    noisy = S.analyze(make_fixture("noisy")).noise_sigma
    assert quiet < 0.005, f"无噪点合成图的估计应接近 0,实际 {quiet}"
    assert noisy > quiet * 5
    assert noisy > 0.03, f"注入 sigma=0.06 的图应被明显检出,实际 {noisy}"


# ---- 肤色检测 ----

def test_skin_detection_on_standard_and_dark_skin():
    """深肤色必须同样能检出 —— 否则肤色保护(硬校验 R3)对深肤色人像静默失效。"""
    light = S.analyze(make_fixture("skin_tone"))
    dark = S.analyze(make_fixture("skin_dark"))
    assert light.skin_ratio > 0.20
    assert dark.skin_ratio > 0.20, "深肤色未被检出"


def test_skin_detection_rejects_non_skin_scene():
    """风景图不能被判成大片肤色 —— 否则肤色保护会在错误的区域生效。"""
    s = S.analyze(make_fixture("neutral"))
    assert s.skin_ratio < 0.10, f"中性风景图的肤色占比应很低,实际 {s.skin_ratio}"


def test_skin_mean_recorded_when_present():
    s = S.analyze(make_fixture("skin_tone"))
    assert s.skin_mean_rgb is not None
    r, g, b = s.skin_mean_rgb
    assert r > g > b, "标准肤色的通道顺序应为 R > G > B"
    assert s.skin_lum_p50 is not None


def test_skin_absent_leaves_none():
    s = S.analyze(make_fixture("highlight_clip"))
    if s.skin_ratio == 0.0:
        assert s.skin_mean_rgb is None
        assert s.skin_lum_p50 is None


# ---- 降采样 ----

def test_downsample_limits_long_side():
    big = make_fixture("neutral", size=(1200, 1600))
    small = S.downsample(big, max_side=512)
    assert max(small.shape[:2]) == 512
    # 长宽比保持
    assert abs(small.shape[1] / small.shape[0] - 1600 / 1200) < 0.02


def test_downsample_noop_when_small_enough():
    small = make_fixture("neutral", size=(100, 120))
    assert S.downsample(small, max_side=512) is small


def test_analyze_downsample_preserves_verdict():
    """降采样只影响速度,不应改变诊断结论(否则大小图行为不一致)。"""
    big = make_fixture("under_exposed", size=(900, 1200))
    small = make_fixture("under_exposed", size=(225, 300))
    a, b = S.analyze(big), S.analyze(small)
    assert abs(a.lum_p50 - b.lum_p50) < 0.03
    assert a.highlight_clip_pct == pytest.approx(b.highlight_clip_pct, abs=1.0)


# ---- load_image ----

def test_load_image_roundtrip():
    data = make_jpeg_bytes("neutral", size=(120, 160))
    img = S.load_image(data)
    assert img.dtype == np.float32
    assert img.shape == (120, 160, 3)
    assert 0.0 <= img.min() and img.max() <= 1.0


def test_load_image_rejects_empty():
    with pytest.raises(CorruptImageError):
        S.load_image(b"")


def test_load_image_rejects_garbage():
    with pytest.raises(CorruptImageError):
        S.load_image(b"this is definitely not an image")


def test_load_image_rejects_oversized_pixels():
    """解码炸弹防护:先读头部,像素数超限直接拒,不进解码。"""
    from PIL import Image
    import io
    big = Image.new("RGB", (9000, 9000), (10, 10, 10))
    buf = io.BytesIO()
    big.save(buf, "PNG")
    with pytest.raises(ImageTooLargeError):
        S.load_image(buf.getvalue())


def test_load_image_handles_non_rgb_png():
    from PIL import Image
    import io
    gray = Image.new("L", (40, 60), 128)
    buf = io.BytesIO()
    gray.save(buf, "PNG")
    img = S.load_image(buf.getvalue())
    assert img.shape == (60, 40, 3), "灰度图应被转成三通道"


# ---- to_prompt_dict ----

def test_prompt_dict_is_compact_and_rounded():
    d = S.to_prompt_dict(S.analyze(make_fixture("skin_tone")))
    assert len(d) <= 16, f"喂 LLM 的字典应保持紧凑,实际 {len(d)} 个字段"
    for k, v in d.items():
        assert isinstance(v, (int, float)), f"{k} 不是数值"
        assert round(float(v), 4) == float(v), f"{k} 未按约定取整"


def test_prompt_dict_includes_skin_only_when_present():
    with_skin = S.to_prompt_dict(S.analyze(make_fixture("skin_tone")))
    no_skin = S.to_prompt_dict(S.analyze(make_fixture("highlight_clip")))
    assert "skin_ratio" in with_skin
    assert "skin_ratio" not in no_skin


def test_sampled_px_reflects_downsample():
    s = S.analyze(make_fixture("neutral", size=(1000, 1400)))
    assert s.sampled_px <= 512 * 512
    assert s.width == 1400 and s.height == 1000, "原始尺寸应保留"


def test_performance_budget():
    """统计要在几十毫秒内完成 —— 单次自动修图会调用它约 6 次。"""
    import time
    img = make_fixture("neutral", size=(2000, 3000))
    t0 = time.time()
    S.analyze(img)
    assert (time.time() - t0) < 0.5, "单次统计超出 0.5s 预算"


# ---- fixture 校准表 ----
#
# 这些数值是 fixture 的「指纹」。改动 fixture 或统计实现后,这张表会立刻失败 ——
# 提醒你下游断言(quality 阈值、硬校验)可能需要同步,而不是让它们悄悄失准。

FIXTURE_FINGERPRINT = {
    # kind:              (p50 下限, p50 上限, range 下限, B−R 下限, B−R 上限)
    "neutral":           (0.30, 0.48, 0.50, -0.02, 0.15),
    "under_exposed":     (0.10, 0.24, 0.20, -0.02, 0.15),
    "over_exposed":      (0.60, 0.85, 0.50, -0.02, 0.20),
    "low_contrast":      (0.33, 0.48, 0.05, -0.05, 0.10),
    "flat_haze":         (0.33, 0.48, 0.05, -0.05, 0.10),
    "warm_cast":         (-1.0, 1.0, 0.40, -0.35, -0.10),
    "cool_cast":         (-1.0, 1.0, 0.40, 0.10, 0.40),
    "shadow_blue":       (-1.0, 1.0, 0.45, -0.20, 0.10),
    "over_saturated":    (-1.0, 1.0, 0.40, 0.05, 0.30),
    "highlight_clip":    (0.85, 1.00, 0.40, -0.05, 0.15),
    "skin_tone":         (0.30, 0.58, 0.30, -0.15, 0.05),
    "skin_dark":         (0.30, 0.58, 0.30, -0.15, 0.05),
    "noisy":             (0.28, 0.48, 0.45, -0.02, 0.15),
}


@pytest.mark.parametrize("kind", sorted(FIXTURE_FINGERPRINT))
def test_fixture_fingerprint(kind):
    """fixture 的关键特征必须落在标定区间内。

    越界说明 fixture 变了 —— 那下游所有基于它的断言都要重新校准。
    """
    lo50, hi50, lo_range, lo_bmr, hi_bmr = FIXTURE_FINGERPRINT[kind]
    s = S.analyze(make_fixture(kind))
    rng = s.lum_p95 - s.lum_p5
    bmr = s.rgb_mean[2] - s.rgb_mean[0]
    assert lo50 <= s.lum_p50 <= hi50, f"{kind} p50={s.lum_p50:.3f} 越界 [{lo50},{hi50}]"
    assert rng >= lo_range, f"{kind} range={rng:.3f} 低于下限 {lo_range}"
    assert lo_bmr <= bmr <= hi_bmr, f"{kind} B−R={bmr:+.3f} 越界 [{lo_bmr},{hi_bmr}]"


def test_neutral_fixture_produces_no_issues():
    """基准图不能被诊断出任何问题 —— 否则「无缺陷」这个前提就不成立,
    所有「有缺陷的图能检出」的断言都失去对照意义。"""
    from photo.quality import diagnose
    codes = [i.code for i in diagnose(S.analyze(make_fixture("neutral")))]
    assert codes == [], f"基准图被诊断出问题: {codes}"
