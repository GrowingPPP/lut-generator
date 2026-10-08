"""图像 → 客观测量(PhotoStats)。

纯函数、确定性:同一输入必然得到同一组数字。这是整套自动修图的地基 ——
测量算错了,上面所有断言都在验证一个错误的世界。

计算全部在**编码值域**(0..1)上完成,不做线性化:判据阈值是按编码值标定的。
"""
import io
from typing import Dict, Optional, Tuple

import numpy as np
from PIL import Image, ImageFile, ImageOps

from .types import CorruptImageError, ImageTooLargeError, UnsupportedImageError, PhotoStats

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
MAX_PIXELS = 8000 * 8000

_LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
# BT.601 的 RGB→YCbCr 系数(与肤色区间配套,不要换成 709)
_YCC = np.array([
    [0.299, 0.587, 0.114],
    [-0.168736, -0.331264, 0.5],
    [0.5, -0.418688, -0.081312],
], np.float32)

# 损坏图片容错:允许截断的 JPEG 尽最大努力解码,而不是直接抛错
ImageFile.LOAD_TRUNCATED_IMAGES = True


def load_image(data: bytes) -> np.ndarray:
    """bytes → float32 RGB HxWx3,值域 0..1,EXIF 方向已应用。

    校验的是**实际内容**而不是声明的 MIME 类型。
    """
    if not data:
        raise CorruptImageError("图片内容为空")
    try:
        img = Image.open(io.BytesIO(data))
        img.verify()                     # 先验完整性
    except UnsupportedImageError:
        raise
    except Exception as exc:
        raise CorruptImageError(f"图片无法解码:{exc}") from exc

    try:
        img = Image.open(io.BytesIO(data))   # verify 之后必须重新打开
        if img.width * img.height > MAX_PIXELS:
            raise ImageTooLargeError(
                f"图片像素数 {img.width}×{img.height} 超出上限 {MAX_PIXELS}"
            )
        img = ImageOps.exif_transpose(img)   # 应用方向,否则统计的是旋转过的图
        img = img.convert("RGB")
    except ImageTooLargeError:
        raise
    except Exception as exc:
        raise CorruptImageError(f"图片无法读取:{exc}") from exc

    arr = np.asarray(img, dtype=np.float32) / 255.0
    return np.ascontiguousarray(arr)


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
    """RGB(0..255) → 肤色布尔掩码。"""
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


def analyze(img: np.ndarray) -> PhotoStats:
    """完整测量。img 为 float32 HxWx3,值域 0..1。

    不裁剪输入:允许超界值,这样「已经很亮/很暗」的信息不会在测量前就被抹掉。
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
        out["skin_ratio"] = round(stats.skin_ratio, 3)
        out["skin_r"] = round(stats.skin_mean_rgb[0], 3)
        out["skin_g"] = round(stats.skin_mean_rgb[1], 3)
        out["skin_b"] = round(stats.skin_mean_rgb[2], 3)
    return out
