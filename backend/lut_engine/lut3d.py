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
        lin = vlog.vlog_decode_to_rec709_linear(flat)
    else:
        lin = colorspace.srgb_eotf(flat)

    lin = transforms.apply_technical_ops(lin, params)
    if params.base_photo_style == "VLOG":
        lin = vlog.tone_map_aces(lin, params.tone_map)
    creative_lin = transforms.apply_creative_linear_ops(lin, params)

    encode = vlog.linear_to_rec709 if params.base_photo_style == "VLOG" else colorspace.srgb_oetf
    base_enc = encode(lin)
    enc = encode(creative_lin)

    base = np.clip(base_enc, 0.0, 1.0)
    look = transforms.apply_encoded_ops(enc, params)
    out = base + params.look_strength * (look - base)
    return out.reshape(size, size, size, 3)
