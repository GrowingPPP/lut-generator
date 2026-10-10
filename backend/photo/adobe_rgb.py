"""标准 Adobe RGB (1998) 的 8 位 RGB 像素转换到 sRGB。

色彩定义来自 Adobe RGB (1998) Color Image Encoding (2005-05)：
https://www.adobe.com/digitalimag/pdfs/AdobeRGB1998.pdf
采用归一化 D65 色度、精确 563/256 gamma 和相对色度裁切。
"""
import numpy as np
from PIL import Image

from lut_engine.colorspace import srgb_oetf

from .types import UnsupportedImageError

TILE_PIXELS = 262_144
_ADOBE_GAMMA = 563 / 256
_D65_XY = (0.3127, 0.3290)
_ADOBE_PRIMARIES = ((0.64, 0.33), (0.21, 0.71), (0.15, 0.06))
_SRGB_PRIMARIES = ((0.64, 0.33), (0.30, 0.60), (0.15, 0.06))


def _rgb_to_xyz(primaries):
    xy = np.asarray(primaries, dtype=np.float64).T
    basis = np.vstack((xy[0] / xy[1], np.ones(3), (1 - xy.sum(axis=0)) / xy[1]))
    white_x, white_y = _D65_XY
    white = np.array((white_x / white_y, 1, (1 - white_x - white_y) / white_y))
    return basis * np.linalg.solve(basis, white)


# 两种编码共用 D65；不需要往返 ICC 的 D50 连接空间。
_ADOBE_TO_SRGB = np.linalg.solve(_rgb_to_xyz(_SRGB_PRIMARIES), _rgb_to_xyz(_ADOBE_PRIMARIES))
_ADOBE_TO_SRGB.setflags(write=False)


def adobe_rgb_to_srgb(image: Image.Image, *, tile_pixels: int = TILE_PIXELS) -> Image.Image:
    """转换已确认编码的 RGB 图，保持尺寸并返回不含源元数据的新图。

    每个临时浮点色块最多包含 tile_pixels 个像素；整张照片仅保留
    Pillow 输入和输出像素图。超出 sRGB 的分量在编码前裁切到 [0, 1]。
    不猜测编码、不读取 EXIF，也不保留源 ICC、GPS、XMP 或方向信息。
    """
    if not isinstance(image, Image.Image) or image.mode != "RGB" or min(image.size) <= 0:
        raise UnsupportedImageError("Adobe RGB 转换需要非空的 8 位 RGB 图像")
    if type(tile_pixels) is not int or tile_pixels <= 0:
        raise ValueError("色彩转换的分块像素数必须为正整数")

    width, height = image.size
    tile_width = min(width, tile_pixels)
    tile_height = max(1, tile_pixels // tile_width)
    output = Image.new("RGB", image.size)
    for top in range(0, height, tile_height):
        bottom = min(top + tile_height, height)
        for left in range(0, width, tile_width):
            right = min(left + tile_width, width)
            encoded = np.asarray(image.crop((left, top, right, bottom)), dtype=np.float64) / 255
            linear = np.power(encoded, _ADOBE_GAMMA) @ _ADOBE_TO_SRGB.T
            np.clip(linear, 0, 1, out=linear)
            pixels = (srgb_oetf(linear) * 255 + 0.5).astype(np.uint8)
            output.paste(Image.fromarray(pixels), (left, top))
    return output
