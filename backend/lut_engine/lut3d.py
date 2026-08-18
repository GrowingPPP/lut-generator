"""3D LUT 生成:按参数链对网格每个格点做正向变换。"""
import numpy as np

from .params import LutParams
from . import transforms, vlog, colorspace


def build_grid(size):
    """构建 size^3 的输入网格,值域 [0,1],shape (size, size, size, 3)。"""
    coords = np.linspace(0.0, 1.0, size)
    r, g, b = np.meshgrid(coords, coords, coords, indexing="ij")
    return np.stack([r, g, b], axis=-1)


def generate_lut(params: LutParams, size: int = 33):
    """生成 3D LUT,shape (size, size, size, 3)。

    统一管线:线性化 → 线性算子 → 编码化 → 编码算子。
    线性化/编码化按基准选择(sRGB 照片线 / V-Log 视频线)。
    """
    grid = build_grid(size)
    flat = grid.reshape(-1, 3)

    if params.base_photo_style == "VLOG":
        lin = vlog.vlog_to_linear_rgb(flat, params.tone_map)
    else:
        lin = colorspace.srgb_eotf(flat)

    lin = transforms.apply_linear_ops(lin, params)

    if params.base_photo_style == "VLOG":
        enc = vlog.linear_to_rec709(lin)
    else:
        enc = colorspace.srgb_oetf(lin)

    out = transforms.apply_encoded_ops(enc, params)
    return out.reshape(size, size, size, 3)
