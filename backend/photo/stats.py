"""图像 → 客观测量(PhotoStats)。

纯函数、确定性:同一输入必然得到同一组数字。这是整套自动修图的地基 ——
测量算错了,上面所有断言都在验证一个错误的世界。

计算全部在**编码值域**(0..1)上完成,不做线性化:判据阈值是按编码值标定的。
"""
from typing import Dict, Optional, Tuple

import numpy as np
from PIL import Image

from .types import PhotoStats
from .color_management import MAX_PIXELS, PREVIEW_SIDE, photo_array

# 统计前降采样到此长边。分位数对采样密度不敏感,降采样只影响速度不影响判据。
MAX_ANALYZE_SIDE = 512

# 肤色检测:YCbCr 经典区间(Chai & Ngan)+ 三条额外约束。
#
# 只用 Cb/Cr 区间是不够的:实测**米色天空(Cr=135)与浅暖高光(Cr=144)都会落进区间**,
# 导致一张风景图被判成 79% 是肤色。三条约束是判别肤色的标准做法:
#   - R 必须是最大通道(肤色是暖色)
#   - 必须有最低色度(排除近中性灰)
#   - R−B 必须达到最低暖度
# 经验值,已由合成图与「冷调下不误判」两条回归锁定。
SKIN_CB_RANGE = (77.0, 127.0)
SKIN_CR_RANGE = (133.0, 173.0)
SKIN_Y_RANGE = (40.0, 235.0)
SKIN_MIN_CHROMA = 15.0     # (0..255 尺度下的 max-min)
SKIN_MIN_R_MINUS_B = 12.0

CLIP_HIGH = 0.98
CLIP_LOW = 0.02
DARK_Q = 0.20
BRIGHT_Q = 0.80

# 单张图最大像素数(PIL 的 decompression bomb 阈值远高于此,这里自己收一道)
MAX_RENDER_SIDE = PREVIEW_SIDE

_LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
# BT.601 的 RGB→YCbCr 系数(与肤色区间配套,不要换成 709)
_YCC = np.array([
    [0.299, 0.587, 0.114],
    [-0.168736, -0.331264, 0.5],
    [0.5, -0.418688, -0.081312],
], np.float32)

def load_image(data: bytes, base_photo_style: str = "STD") -> np.ndarray:
    """使用照片预览同一解码流程，返回 float32 编码 RGB，EXIF 方向已应用。"""
    return photo_array(data, base_photo_style, max_pixels=MAX_PIXELS)


def downsample(img: np.ndarray, max_side: int = MAX_ANALYZE_SIDE) -> np.ndarray:
    """长边超过 max_side 时等比缩小。用 LANCZOS 保留分位数特征。"""
    h, w = img.shape[:2]
    long_side = max(h, w)
    if long_side <= max_side:
        return img
    scale = max_side / long_side
    new_size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    pil = Image.fromarray((np.clip(img, 0.0, 1.0) * 255).astype(np.uint8), "RGB")
    pil = pil.resize(new_size, Image.LANCZOS)
    return np.asarray(pil, dtype=np.float32) / 255.0


def _ycbcr_mask(rgb255: np.ndarray) -> np.ndarray:
    """RGB(0..255) → 疑似肤色颜色掩码,不提供人物证据。"""
    ycc = rgb255 @ _YCC.T + np.array([0.0, 128.0, 128.0], np.float32)
    y, cb, cr = ycc[:, 0], ycc[:, 1], ycc[:, 2]
    r, g, b = rgb255[:, 0], rgb255[:, 1], rgb255[:, 2]
    return (
        (cb >= SKIN_CB_RANGE[0]) & (cb <= SKIN_CB_RANGE[1])
        & (cr >= SKIN_CR_RANGE[0]) & (cr <= SKIN_CR_RANGE[1])
        & (y >= SKIN_Y_RANGE[0]) & (y <= SKIN_Y_RANGE[1])
        & (r >= g) & (r >= b)                                  # 暖色:R 主导
        & (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) >= SKIN_MIN_CHROMA)
        & (r - b >= SKIN_MIN_R_MINUS_B)
    )


def _noise_sigma(lum: np.ndarray) -> float:
    """高频残差的中位绝对偏差(×1.4826 换算成标准差)。

    用 MAD 而非 std:真实边缘是少数像素,std 会被它们污染,MAD 不会。
    """
    h, w = lum.shape
    if h < 3 or w < 3:
        return 0.0
    # 3×3 均值滤波(用累积和实现,避免额外依赖)
    pad = np.pad(lum, 1, mode="edge")
    csum = np.cumsum(np.cumsum(pad, axis=0), axis=1)
    csum = np.pad(csum, ((1, 0), (1, 0)))
    k = 3
    total = (
        csum[k:, k:] - csum[:-k, k:] - csum[k:, :-k] + csum[:-k, :-k]
    )[:h, :w]
    blurred = total / (k * k)
    residual = lum - blurred
    mad = float(np.median(np.abs(residual - np.median(residual))))
    return mad * 1.4826


def analyze(img: np.ndarray, skin_mask: Optional[np.ndarray] = None) -> PhotoStats:
    """完整测量。img 为 float32 HxWx3,值域 0..1。

    不裁剪输入:允许超界值,这样「已经很亮/很暗」的信息不会在测量前就被抹掉。

    `skin_mask`:可选的**降采样尺寸**布尔掩码。传入时肤色统计固定在这批像素上,
    而不是按当前图像重算。

    为什么需要它:肤色判定是按 YCbCr 阈值做的,而 LUT 会改变颜色 —— 于是每轮
    重算掩码就等于每轮换了「哪些像素算皮肤」。实测这会让肤色均值偏移虚高 4 倍
    (色温 -800K 真实只移 0.031,重算掩码后报 0.138),把本来安全的修正误判为
    「肤色偏移过大」。硬校验要判断的是「同一个人被改了多少」,不是「这次谁被
    算成了皮肤」,所以必须把像素集合锁在基线上。
    """
    if img.ndim != 3 or img.shape[2] < 3:
        raise ValueError(f"期望 HxWx3 的 RGB 图,收到 shape={img.shape}")

    small = downsample(img[:, :, :3])
    h, w = small.shape[:2]
    flat = small.reshape(-1, 3).astype(np.float32)
    n = flat.shape[0]

    lum = flat @ _LUMA
    order = np.argsort(lum, kind="stable")
    p1, p5, p50, p95, p99 = np.percentile(lum, [1, 5, 50, 95, 99])

    mx = flat.max(axis=1)
    highlight_clip = float((mx > CLIP_HIGH).mean() * 100.0)
    # 三通道都接近 0 才算压死(单通道低可能是饱和色的正常表现)
    shadow_clip = float((mx < CLIP_LOW).mean() * 100.0)

    rgb_mean = tuple(float(v) for v in flat.mean(axis=0))
    rgb_median = tuple(float(v) for v in np.median(flat, axis=0))

    n_dark = max(1, int(n * DARK_Q))
    n_bright = max(1, int(n * BRIGHT_Q))
    dark_sel = flat[order[:n_dark]]
    bright_sel = flat[order[-n_bright:]]
    shadow_cast = tuple(float(v) for v in dark_sel.mean(axis=0))
    highlight_cast = tuple(float(v) for v in bright_sel.mean(axis=0))

    gm = float(np.mean(rgb_mean))
    gray_world_dev = float(np.sqrt(np.mean((np.asarray(rgb_mean) - gm) ** 2)))

    sat = (flat.max(axis=1) - flat.min(axis=1)) / np.maximum(flat.max(axis=1), 1e-6)
    saturation_mean = float(sat.mean())
    saturation_p95 = float(np.percentile(sat, 95))

    # 优先用外部传入的基线掩码 —— 见 analyze 的 docstring
    if skin_mask is not None and skin_mask.shape == (n,):
        skin = skin_mask
    else:
        skin = _ycbcr_mask(flat * 255.0)
    skin_ratio = float(skin.mean())
    skin_mean_rgb: Optional[Tuple[float, float, float]] = None
    skin_lum_p50: Optional[float] = None
    if skin_ratio > 0.0:
        sel = flat[skin]
        skin_mean_rgb = tuple(float(v) for v in sel.mean(axis=0))
        skin_lum_p50 = float(np.median(sel @ _LUMA))

    return PhotoStats(
        width=int(img.shape[1]),
        height=int(img.shape[0]),
        sampled_px=int(n),
        lum_p1=float(p1), lum_p5=float(p5), lum_p50=float(p50),
        lum_p95=float(p95), lum_p99=float(p99),
        highlight_clip_pct=highlight_clip,
        shadow_clip_pct=shadow_clip,
        rgb_mean=rgb_mean, rgb_median=rgb_median,
        shadow_cast=shadow_cast, highlight_cast=highlight_cast,
        gray_world_dev=gray_world_dev,
        saturation_mean=saturation_mean, saturation_p95=saturation_p95,
        skin_ratio=skin_ratio, skin_mean_rgb=skin_mean_rgb, skin_lum_p50=skin_lum_p50,
        noise_sigma=_noise_sigma(lum.reshape(h, w).astype(np.float32)),
    )


def skin_mask_of(img: np.ndarray) -> np.ndarray:
    """取降采样疑似肤色颜色掩码(扁平 bool 数组),供后续各轮固定使用。

    与 analyze 内部走同一条降采样与阈值路径,保证形状与判定一致。
    """
    small = downsample(img[:, :, :3])
    flat = small.reshape(-1, 3).astype(np.float32)
    return _ycbcr_mask(flat * 255.0)


def to_prompt_dict(stats: PhotoStats) -> Dict[str, float]:
    """转成喂给 LLM 的紧凑字典。

    这个 dict 每次调用都进 prompt,字段膨胀是无声的成本泄漏 —— 有测试限制字段数与小数位。
    """
    out: Dict[str, float] = {
        "lum_p5": round(stats.lum_p5, 3),
        "lum_p50": round(stats.lum_p50, 3),
        "lum_p95": round(stats.lum_p95, 3),
        "highlight_clip_pct": round(stats.highlight_clip_pct, 2),
        "shadow_clip_pct": round(stats.shadow_clip_pct, 2),
        "gray_world_dev": round(stats.gray_world_dev, 3),
        "saturation_mean": round(stats.saturation_mean, 3),
        "noise_sigma": round(stats.noise_sigma, 4),
    }
    out["rgb_mean_r"] = round(stats.rgb_mean[0], 3)
    out["rgb_mean_g"] = round(stats.rgb_mean[1], 3)
    out["rgb_mean_b"] = round(stats.rgb_mean[2], 3)
    out["shadow_cast_b_minus_r"] = round(stats.shadow_cast[2] - stats.shadow_cast[0], 3)
    if stats.skin_ratio > 0.02 and stats.skin_mean_rgb is not None:
        out["suspected_skin_ratio"] = round(stats.skin_ratio, 3)
        out["suspected_skin_r"] = round(stats.skin_mean_rgb[0], 3)
        out["suspected_skin_g"] = round(stats.skin_mean_rgb[1], 3)
        out["suspected_skin_b"] = round(stats.skin_mean_rgb[2], 3)
    return out
