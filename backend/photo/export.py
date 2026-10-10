"""从原始分辨率照片应用 LUT 并导出带 sRGB 配置的静态图片。"""
import io
from dataclasses import dataclass

import numpy as np
from PIL import Image

from .color_management import decode_photo, display_rgb, srgb_profile
from .render import lut_from_params, render_lut

TILE_PIXELS = 262_144


@dataclass(frozen=True)
class ExportedPhoto:
    data: bytes
    width: int
    height: int
    media_type: str


def export_photo(data: bytes, params: dict, *, output_format="jpeg", quality=95) -> ExportedPhoto:
    if output_format not in ("jpeg", "png"):
        raise ValueError("导出格式必须为 JPEG 或 PNG")
    if not isinstance(quality, int) or not 80 <= quality <= 100:
        raise ValueError("JPEG 质量需在 80 到 100 之间")
    style = params.get("base_photo_style", "STD")
    photo = decode_photo(data, style, max_side=None)
    source = photo.image
    lut = lut_from_params(params, size=33)
    target = Image.new("RGB", source.size)
    rows = max(1, TILE_PIXELS // source.width)
    for top in range(0, source.height, rows):
        bottom = min(source.height, top + rows)
        rgb = np.asarray(source.crop((0, top, source.width, bottom)), dtype=np.float32) / 255.0
        graded = render_lut(lut, rgb)
        graded = display_rgb(graded, style)
        tile = Image.fromarray((np.clip(graded, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
        target.paste(tile, (0, top))
    output = io.BytesIO()
    options = {"icc_profile": srgb_profile()}
    if output_format == "jpeg":
        options.update(quality=quality, subsampling=0, optimize=True)
    target.save(output, "JPEG" if output_format == "jpeg" else "PNG", **options)
    return ExportedPhoto(output.getvalue(), target.width, target.height,
                         "image/jpeg" if output_format == "jpeg" else "image/png")
