"""3D LUT 生成:按参数链对网格每个格点做正向变换。"""
import numpy as np

from .params import LutParams
from . import transforms, vlog, colorspace
from .curves import apply_free_curves
from .imported import CubeError, sample_imported_lut


def build_grid(size):
    """构建 size^3 的输入网格,值域 [0,1],shape (size, size, size, 3)。"""
    coords = np.linspace(0.0, 1.0, size)
    r, g, b = np.meshgrid(coords, coords, coords, indexing="ij")
    return np.stack([r, g, b], axis=-1)


def generate_lut(params: LutParams, size: int = 33, external_lut=None):
    """生成 3D LUT,shape (size, size, size, 3)。

    统一管线:线性化 → 线性算子 → 编码化 → 编码算子。
    线性化/编码化按基准选择(sRGB 照片线 / V-Log 视频线)。
    """
    grid = build_grid(size)
    flat = grid.reshape(-1, 3)

    if params.external_lut_id is not None and external_lut is None:
        raise CubeError("missing_artifact", "外部 LUT 引用尚未解析,不能生成效果")
    output_encoding = "Rec709" if params.base_photo_style == "VLOG" else "sRGB"
    if external_lut is not None and params.external_lut_id is not None:
        expected = "VLOG" if params.external_lut_mode == "input" else output_encoding
        if external_lut.input_encoding != expected or external_lut.output_encoding != output_encoding:
            raise CubeError("input_conflict", "外部 LUT 声明与当前输入输出编码不匹配")

    if params.external_lut_mode == "input":
        encoded = sample_imported_lut(external_lut, flat)
        lin = np.where(encoded <= 0.081, encoded / 4.5, ((encoded + 0.099) / 1.099) ** (1 / 0.45))
    elif params.base_photo_style == "VLOG":
        lin = vlog.vlog_decode_to_rec709_linear(flat)
    else:
        lin = colorspace.srgb_eotf(flat)

    lin = transforms.apply_technical_ops(lin, params)
    if params.base_photo_style == "VLOG" and params.external_lut_mode != "input":
        lin = vlog.tone_map_aces(lin, params.tone_map)
    creative_lin = transforms.apply_creative_linear_ops(lin, params)

    encode = vlog.linear_to_rec709 if params.base_photo_style == "VLOG" else colorspace.srgb_oetf
    base_enc = encode(lin)
    enc = encode(creative_lin)

    base = np.clip(base_enc, 0.0, 1.0)
    look = transforms.apply_encoded_ops(enc, params)
    look = apply_free_curves(look, params.curve_points)
    out = base + params.look_strength * (look - base)
    if params.external_lut_id is not None and params.external_lut_mode == "display":
        mapped = sample_imported_lut(external_lut, out)
        out = out + params.external_lut_strength * (mapped - out)
    return out.reshape(size, size, size, 3)
