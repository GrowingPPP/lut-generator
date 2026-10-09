"""V-Log → Rec.709 转换。V-Log 反曲线、色域矩阵和简化的 Narkowicz 显示映射。"""
import numpy as np

# V-Gamut → Rec.709 色域矩阵(由原色标准经 RGB→XYZ→RGB 计算)
V_GAMUT_TO_709 = np.array([
    [1.806576, -0.695697, -0.110879],
    [-0.170090, 1.305955, -0.135865],
    [-0.025206, -0.154468, 1.179674],
])


def vlog_to_linear(vlog):
    """V-Log 编码(0-1)→ 线性场景反射率。松下 VARICAM V-Log 官方反曲线。"""
    lin = np.where(
        vlog < 0.181,
        (vlog - 0.125) / 5.6,
        np.power(10.0, (vlog - 0.598206) / 0.241514) - 0.00873,
    )
    return lin


def tone_map_aces(linear, strength=1.0):
    """Narkowicz ACES 风格近似曲线,同时改变中间调与高光。

    strength 0=不压缩,1=全压缩,中间值线性插值。
    """
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    x = np.clip(linear, 0.0, None)
    mapped = (x * (a * x + b)) / (x * (c * x + d) + e)
    return x + (mapped - x) * strength


def linear_to_rec709(linear):
    """线性 → Rec.709 编码(BT.709 OETF)。"""
    e = np.clip(linear, 0.0, None)
    return np.where(
        e < 0.018,
        4.5 * e,
        1.099 * np.power(e, 0.45) - 0.099,
    )


def vlog_to_linear_rgb(rgb, tone_map=1.0):
    """V-Log 编码 RGB → 线性 Rec.709 RGB(反曲线 + 色域矩阵 + tone mapping)。"""
    return tone_map_aces(vlog_decode_to_rec709_linear(rgb), tone_map)


def vlog_decode_to_rec709_linear(rgb):
    """解码 V-Log/V-Gamut；供曝光与白平衡在显示映射前使用。"""
    lin = vlog_to_linear(rgb)
    return lin @ V_GAMUT_TO_709.T


def vlog_to_rec709(rgb):
    """V-Log 编码 RGB(0-1)→ Rec.709 编码 RGB(0-1)。完整转换。"""
    return np.clip(linear_to_rec709(vlog_to_linear_rgb(rgb)), 0.0, 1.0)
