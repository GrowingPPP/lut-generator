"""色彩算子。线性域算子与编码域算子分离。"""
import numpy as np

from . import colorspace

_LUMA = np.array([0.2126, 0.7152, 0.0722])  # Rec.709 亮度权重


# ---- 线性域算子(去 gamma 后) ----


def apply_white_balance(rgb_linear, temp, tint):
    """白平衡:黑体辐射 RGB 增益。"""
    return rgb_linear * colorspace.white_balance_gain(temp, tint)


def apply_exposure(rgb_linear, ev):
    """曝光:线性域乘 2^ev。"""
    return rgb_linear * (2.0 ** ev)


def apply_lift(rgb_linear, lift):
    """Lift:暗部偏移(线性域加)。"""
    return rgb_linear + np.asarray(lift)


def apply_gain(rgb_linear, gain):
    """Gain:亮部增益(线性域乘)。"""
    return rgb_linear * np.asarray(gain)


# ---- 编码域算子(编码后) ----


def apply_contrast(rgb_encoded, contrast, pivot=0.462):
    """对比度:围绕 pivot(18% 中灰)拉伸。"""
    return (rgb_encoded - pivot) * (1.0 + contrast) + pivot


def apply_gamma(rgb_encoded, gamma):
    """Gamma:中间调幂。"""
    return np.power(np.clip(rgb_encoded, 0.0, None), 1.0 / np.asarray(gamma))


def apply_saturation(rgb_encoded, saturation):
    """饱和度:以 Rec.709 亮度为轴缩放色度。"""
    y = rgb_encoded @ _LUMA
    return y[..., None] + (rgb_encoded - y[..., None]) * (1.0 + saturation)


def apply_hue(rgb_encoded, hue_deg):
    """色相:绕 Rec.709 亮度轴旋转,后做色域压缩。"""
    if hue_deg == 0.0:
        return rgb_encoded
    theta = np.radians(hue_deg)
    c, s = np.cos(theta), np.sin(theta)
    m = np.array([
        [0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.928 * s],
        [0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.140 * s, 0.072 - 0.072 * c - 0.283 * s],
        [0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s],
    ])
    return gamut_clamp(rgb_encoded @ m.T)


def gamut_clamp(rgb):
    """保持亮度/色相,等比降饱和让 RGB 回 [0,1]。"""
    luma = rgb @ _LUMA
    mn = rgb.min(axis=-1)
    mx = rgb.max(axis=-1)
    scale = np.ones_like(luma)
    neg = mn < 0
    scale = np.where(neg, np.minimum(scale, luma / np.maximum(luma - mn, 1e-6)), scale)
    pos = mx > 1
    scale = np.where(pos, np.minimum(scale, (1.0 - luma) / np.maximum(mx - luma, 1e-6)), scale)
    scale = np.clip(scale, 0.0, 1.0)
    return luma[..., None] + (rgb - luma[..., None]) * scale[..., None]


def apply_vibrance(rgb_encoded, vibrance):
    """自然饱和度:已饱和区域少加、欠饱和区域多加。"""
    if vibrance == 0.0:
        return rgb_encoded
    mx = rgb_encoded.max(axis=-1)
    mn = rgb_encoded.min(axis=-1)
    saturation = (mx - mn) / np.maximum(mx, 1e-6)
    scale = 1.0 - saturation
    y = rgb_encoded @ _LUMA
    return y[..., None] + (rgb_encoded - y[..., None]) * (1.0 + vibrance * scale[..., None])


# ---- 分段应用 ----


def apply_linear_ops(rgb_linear, params):
    """线性域算子链:白平衡 → 曝光 → Lift → Gain。"""
    out = apply_white_balance(rgb_linear, params.temp, params.tint)
    out = apply_exposure(out, params.exposure)
    out = apply_lift(out, params.lift)
    out = apply_gain(out, params.gain)
    return out


def apply_encoded_ops(rgb_encoded, params):
    """编码域算子链:对比度 → Gamma → 饱和度 → 色相 → 自然饱和。"""
    out = apply_contrast(rgb_encoded, params.contrast)
    out = apply_gamma(out, params.gamma)
    out = apply_saturation(out, params.saturation)
    out = apply_hue(out, params.hue)
    out = apply_vibrance(out, params.vibrance)
    return np.clip(out, 0.0, 1.0)
