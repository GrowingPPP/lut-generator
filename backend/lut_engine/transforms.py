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
    """围绕中灰拉伸，负向增益保留底限，避免整幅画面归于同一灰值。"""
    if contrast == 0.0:
        return rgb_encoded
    slope = 1.0 + (contrast / (1.0 - 0.25 * contrast) if contrast < 0 else contrast)
    return (rgb_encoded - pivot) * slope + pivot


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


def apply_selective_color(rgb_encoded, center, width, hue_shift, saturation):
    """在目标色相周围做平滑的色相与饱和度调整；低色度区域不参与。"""
    if hue_shift == 0.0 and saturation == 0.0:
        return rgb_encoded
    c = np.clip(rgb_encoded, 0.0, 1.0)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    mx, mn = c.max(axis=-1), c.min(axis=-1)
    chroma = mx - mn
    safe = np.maximum(chroma, 1e-6)
    hue = np.select(
        [mx == r, mx == g],
        [((g - b) / safe) % 6.0, (b - r) / safe + 2.0],
        default=(r - g) / safe + 4.0,
    ) * 60.0
    distance = np.abs((hue - center + 180.0) % 360.0 - 180.0)
    weight = (1.0 - _smoothstep(distance / max(width, 1e-6))) * _smoothstep(chroma / 0.08)
    out = rgb_encoded
    if hue_shift != 0.0:
        rotated = apply_hue(out, hue_shift)
        out = out + weight[..., None] * (rotated - out)
    if saturation != 0.0:
        y = out @ _LUMA
        out = y[..., None] + (out - y[..., None]) * (1.0 + saturation * weight[..., None])
    return out


# ---- 编码域:影调分区与分离色调(逐点,可烘进 33³ LUT)----
#
# 实现约束(实测得出):这些算子的掩码必须是**平滑过渡**,不能有硬阈值。
# 33³ 网格 + 三线性插值会在曲线拐点附近产生插值误差 —— 平滑掩码下最大误差
# 约 2/255 级(肉眼不可见),换成硬阈值则会跳到 40+/255 级(明显串色)。
# 平滑掩码同时也是修图上更正确的做法:硬阈值的调色会产生色带。

# 平滑掩码的分界点。数值按「亮部从中高调开始、暗部从中低调开始」选取。
_HIGHLIGHT_KNEE = 0.5
_SHADOW_KNEE = 0.5


def _smoothstep(x):
    """3x²-2x³:在 [0,1] 上 C¹ 连续,端点导数为 0 —— 这是插值友好的关键。"""
    t = np.clip(x, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def apply_highlights(rgb_encoded, amount):
    """高光:只作用于亮部。负=压高光,正=提亮部；不能恢复已剪切细节。"""
    if amount == 0.0:
        return rgb_encoded
    y = rgb_encoded @ _LUMA
    w = _smoothstep((y - _HIGHLIGHT_KNEE) / (1.0 - _HIGHLIGHT_KNEE))
    # 向 1 的余量方向缩放:亮部按比例靠近/远离白点
    y2 = y + amount * w * (1.0 - y)
    return _rescale_to_luma(rgb_encoded, y, y2)


def apply_shadows(rgb_encoded, amount):
    """阴影:只作用于暗部。正=提阴影,负=压暗部。"""
    if amount == 0.0:
        return rgb_encoded
    y = rgb_encoded @ _LUMA
    w = _smoothstep((_SHADOW_KNEE - y) / _SHADOW_KNEE)
    y2 = y + amount * w * y
    return _rescale_to_luma(rgb_encoded, y, y2)


def apply_whites(rgb_encoded, amount):
    """白部层次:正值增强亮部,负值降低白点；全范围保持灰阶单调。"""
    if amount == 0.0:
        return rgb_encoded
    c = np.clip(rgb_encoded, 0.0, 1.0)
    if amount > 0.0:
        return rgb_encoded + amount * c ** 2 * (1.0 - c)
    effective = amount / (1.0 - amount)
    return rgb_encoded + effective * (2.0 * c - c ** 2)


def apply_blacks(rgb_encoded, amount):
    """黑部层次:正值抬黑位,负值压暗部；全范围保持灰阶单调。"""
    if amount == 0.0:
        return rgb_encoded
    c = np.clip(rgb_encoded, 0.0, 1.0)
    if amount > 0.0:
        effective = amount / (1.0 + amount)
        return rgb_encoded + effective * (1.0 - c) ** 2
    return rgb_encoded + amount * c * (1.0 - c) ** 2


def apply_curve(rgb_encoded, strength):
    """S 曲线:围绕中灰增强/减弱层次。正=增强对比,负=减弱。

    形状是 smoothstep(x) - x:暗部压低、亮部抬高,且 0 / 0.5 / 1 三点固定、
    一阶导连续 —— 既符合修图直觉,又是插值友好的。
    (早期用 sin(2πx)/2π 是错的:它在 (0,0.5) 恒为正,会把暗部一起提亮,
     实际效果是「整体提亮」而非 S 曲线。)
    """
    if strength == 0.0:
        return rgb_encoded
    x = np.clip(rgb_encoded, 0.0, 1.0)
    return rgb_encoded + strength * (_smoothstep(x) - x)


def _rescale_to_luma(rgb, y_old, y_new):
    """保持通道比例地把整体亮度从 y_old 移到 y_new(避免纯加法导致偏色)。"""
    scale = y_new / np.maximum(y_old, 1e-6)
    return rgb * scale[..., None]


def _hue_to_rgb(hue_deg):
    """色相角 → 单位 RGB 方向向量(取最饱和的那个色相)。"""
    h = (hue_deg % 360.0) / 60.0
    i = int(np.floor(h)) % 6
    f = h - np.floor(h)
    table = np.array([
        [1.0, f, 0.0], [1.0 - f, 1.0, 0.0], [0.0, 1.0, f],
        [0.0, 1.0 - f, 1.0], [f, 0.0, 1.0], [1.0, 0.0, 1.0 - f],
    ])
    return table[i]


def apply_split_tone(rgb_encoded, sh_hue, sh_sat, hi_hue, hi_sat, balance,
                     mid_hue=0.0, mid_sat=0.0):
    """分离色调:阴影与高光分别染色,按亮度平滑插值。

    与「颜色分级」同样的思路:阴影色只影响暗部、高光色只影响亮部,中间调两者都弱。
    """
    if sh_sat == 0.0 and hi_sat == 0.0 and mid_sat == 0.0:
        return rgb_encoded
    y = np.clip(rgb_encoded @ _LUMA, 0.0, 1.0)[..., None]
    b = float(np.clip(balance, 0.0, 1.0))
    # b 是分界点,但权重按「1-b」归一,使 b 越大高光染色覆盖越广(与 ACR 分离色调的
    # Balance 方向一致:往右推,高光调色占比更大)。
    # 实测确认:若按 (y-b)/(1-b) 直接归一,方向会反过来(b 越大反而只有暗部被染色)。
    sh_w = _smoothstep((1.0 - b - y) / max(1.0 - b, 1e-6)) if b < 1.0 else np.zeros_like(y)
    hi_w = _smoothstep((y - (1.0 - b)) / max(b, 1e-6)) if b > 0 else np.zeros_like(y)
    tint = np.zeros_like(rgb_encoded)
    if sh_sat > 0:
        tint = tint + sh_w * (sh_sat * 0.5) * (_hue_to_rgb(sh_hue) - 0.5)
    if hi_sat > 0:
        tint = tint + hi_w * (hi_sat * 0.5) * (_hue_to_rgb(hi_hue) - 0.5)
    if mid_sat > 0:
        mid_w = _smoothstep(y / 0.5) * _smoothstep((1.0 - y) / 0.5)
        tint = tint + mid_w * (mid_sat * 0.5) * (_hue_to_rgb(mid_hue) - 0.5)
    return rgb_encoded + tint


def apply_tone_ops(rgb_encoded, params):
    """影调分区链:高光 → 阴影 → 白部 → 黑部 → S 曲线 → 分离色调。

    先做分区提压,再动黑白部层次,最后整体曲线与染色。
    """
    out = apply_highlights(rgb_encoded, params.highlights)
    out = apply_shadows(out, params.shadows)
    out = apply_whites(out, params.whites)
    out = apply_blacks(out, params.blacks)
    out = apply_curve(out, params.curve)
    out = apply_split_tone(
        out,
        params.split_shadow_hue, params.split_shadow_sat,
        params.split_highlight_hue, params.split_highlight_sat,
        params.split_balance, params.split_mid_hue, params.split_mid_sat,
    )
    return out


# ---- 分段应用 ----


def apply_linear_ops(rgb_linear, params):
    """线性域算子链:白平衡 → 曝光 → Lift → Gain。"""
    return apply_creative_linear_ops(apply_technical_ops(rgb_linear, params), params)


def apply_technical_ops(rgb_linear, params):
    """针对当前样张的白平衡与曝光。"""
    out = apply_white_balance(rgb_linear, params.temp, params.tint)
    return apply_exposure(out, params.exposure)


def apply_creative_linear_ops(rgb_linear, params):
    """可由风格强度控制的分通道 Lift/Gain。"""
    return apply_gain(apply_lift(rgb_linear, params.lift), params.gain)


def apply_encoded_ops(rgb_encoded, params):
    """编码域算子链:

    对比度 → Gamma → 饱和/自然饱和 → 色相 → 影调分区(高光/阴影/黑白场/曲线/分离色调)。
    原有 5 步的相对顺序保持不变(改动会让已保存 LUT 的结果漂移),
    新算子追加在**饱和度与色相之后**:它们调的是亮度分区与端点,
    放在色彩处理之后可以避免被饱和度放大或把染色带进色相旋转。
    """
    out = apply_contrast(rgb_encoded, params.contrast, params.contrast_pivot)
    out = apply_gamma(out, params.gamma)
    out = apply_saturation(out, params.saturation)
    out = apply_hue(out, params.hue)
    out = apply_selective_color(out, params.selective_hue_center,
                                params.selective_hue_width, params.selective_hue_shift,
                                params.selective_saturation)
    out = apply_vibrance(out, params.vibrance)
    out = apply_tone_ops(out, params)
    return np.clip(out, 0.0, 1.0)
