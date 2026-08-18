"""色彩空间转换:sRGB/Rec.709 的 EOTF/OETF + 黑体辐射白平衡。"""
import math

import numpy as np


def srgb_eotf(c):
    """sRGB 编码 → 线性。"""
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb_oetf(lin):
    """线性 → sRGB 编码。"""
    lin = np.clip(lin, 0.0, None)
    return np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1.0 / 2.4) - 0.055)


def rec709_eotf(c):
    """Rec.709 编码 → 线性。"""
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.081, c / 4.5, ((c + 0.099) / 1.099) ** (1.0 / 0.45))


def rec709_oetf(lin):
    """线性 → Rec.709 编码(BT.709)。"""
    lin = np.clip(lin, 0.0, None)
    return np.where(lin <= 0.018, 4.5 * lin, 1.099 * lin ** 0.45 - 0.099)


def kelvin_to_rgb(kelvin):
    """色温(Kelvin)→ RGB(0-1)。Tanner Helland 黑体辐射近似。"""
    temp = kelvin / 100.0
    if temp <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(temp) - 161.1195681661
        b = 0.0 if temp <= 19 else 138.5177312231 * math.log(temp - 10.0) - 305.0447927307
    elif temp <= 88:
        r = 329.698727446 * (temp - 60.0) ** -0.1332047592
        g = 288.1221695283 * math.log(temp) - 234.7305138614
        b = 138.5177312231 * math.log(temp - 10.0) - 305.0447927307
    else:
        r = 329.698727446 * (temp - 60.0) ** -0.1332047592
        g = 288.1221695283 * math.log(temp) - 234.7305138614
        b = 255.0
    return np.clip(np.array([r, g, b]) / 255.0, 0.0, 1.0)


_TINT_GAIN = 0.0002


def white_balance_gain(temp_offset, tint):
    """白平衡 RGB 增益,归一化到 6500K = 1。

    temp_offset 正 = 暖(绝对色温降);tint 正 = 绿。
    """
    kelvin = 6500.0 - temp_offset
    gain = kelvin_to_rgb(kelvin) / kelvin_to_rgb(6500.0)
    gain[1] *= 1.0 + tint * _TINT_GAIN
    return gain
