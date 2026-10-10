"""照片规范化：普通照片统一到 sRGB，V-Log 保留原编码值。"""
import io
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import numpy as np
from PIL import Image, ImageCms, ImageFile, ImageOps
from lut_engine.colorspace import rec709_eotf, srgb_oetf

from .types import CorruptImageError, ImageTooLargeError, UnsupportedImageError
from .adobe_rgb import adobe_rgb_to_srgb

MAX_PHOTO_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 64_000_000
PREVIEW_SIDE = 2048
COLOR_VERSION = 1
INPUT_STYLES = frozenset(("STD", "NAT", "VIVD", "VLOG"))
SUPPORTED_FORMATS = frozenset(("JPEG", "PNG", "WEBP", "TIFF", "MPO"))

ImageFile.LOAD_TRUNCATED_IMAGES = True


@lru_cache(maxsize=1)
def srgb_profile() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


@dataclass(frozen=True)
class DecodedPhoto:
    image: Image.Image
    metadata: dict


def _camera_text(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = "".join(char for char in value if char.isprintable()).strip()
    return text[:64] or None


def decode_photo(data: bytes, input_style: str = "STD", *, max_side=PREVIEW_SIDE,
                 max_pixels=None) -> DecodedPhoto:
    """应用方向、ICC、透明度和统一缩放；返回无原始元数据的 RGB 图。"""
    if input_style not in INPUT_STYLES:
        raise UnsupportedImageError("照片输入必须为 STD、NAT、VIVD 或 VLOG")
    if not data:
        raise CorruptImageError("图片内容为空")
    if len(data) > MAX_PHOTO_BYTES:
        raise ImageTooLargeError("图片过大，请压缩到 32MB 以内")
    pixel_limit = MAX_PIXELS if max_pixels is None else min(MAX_PIXELS, max_pixels)
    try:
        with Image.open(io.BytesIO(data)) as check:
            if check.width * check.height > pixel_limit:
                raise ImageTooLargeError(f"图片像素数 {check.width}×{check.height} 超出上限 {pixel_limit:,} 像素")
            if check.format not in SUPPORTED_FORMATS:
                raise UnsupportedImageError("支持 JPEG、PNG、WebP、TIFF 与带缩略图的 MPO 照片")
            if check.format == "MPO":
                mpinfo = getattr(check, "mpinfo", {})
                entries = mpinfo.get(0xB002, [])
                thumbnail_roles = {"Large Thumbnail (VGA Equivalent)",
                                   "Large Thumbnail (Full HD Equivalent)"}
                if not entries or len(entries) != getattr(check, "n_frames", 1):
                    raise UnsupportedImageError("MPO 缺少有效主照片与缩略图索引")
                frame_ranges = []
                for index, entry in enumerate(entries):
                    attribute = entry.get("Attribute", {})
                    role = attribute.get("MPType")
                    allowed = role == "Baseline MP Primary Image" if index == 0 else role in thumbnail_roles
                    if attribute.get("ImageDataFormat") != "JPEG" or not allowed:
                        raise UnsupportedImageError("MPO 只支持一张主照片及辅助缩略图，不支持多画面照片")
                    size, offset = entry.get("Size", 0), entry.get("DataOffset", 0)
                    if size <= 0 or (offset != 0 if index == 0 else offset <= 0):
                        raise UnsupportedImageError("MPO 帧索引的大小或偏移无效")
                    # 读取辅助帧的 JPEG 头来验证索引，不解码其像素。
                    check.seek(index)
                    start, end = check.offset, check.offset + size
                    if (end > len(data) or data[start:start + 3] != b"\xff\xd8\xff"
                            or data[end - 2:end] != b"\xff\xd9"
                            or any(start < other_end and end > other_start
                                   for other_start, other_end in frame_ranges)):
                        raise UnsupportedImageError("MPO 帧索引越界、重叠或未覆盖完整 JPEG")
                    frame_ranges.append((start, end))
                check.seek(0)
            elif "mp" in check.info:
                raise UnsupportedImageError("MPO 索引无法识别，请转换为普通 JPEG 后上传")
            elif getattr(check, "n_frames", 1) != 1:
                raise UnsupportedImageError("请使用静态照片，不支持动图或多页图片")
            check.verify()
        with Image.open(io.BytesIO(data)) as source:
            source.seek(0)
            exif = source.getexif()
            try:
                color_space = exif.get_ifd(0x8769).get(0xA001, exif.get(0xA001))
            except (KeyError, TypeError, ValueError):
                color_space = exif.get(0xA001)
            try:
                interop = exif.get_ifd(0xA005).get(1)
            except (KeyError, TypeError, ValueError):
                interop = None
            declared_adobe_rgb = color_space == 0xFFFF and interop in ("R03", b"R03")
            icc = source.info.get("icc_profile")
            source_mode = source.mode
            tiff_bits = source.tag_v2.get(258, (8,)) if source.format == "TIFF" else (8,)
            if isinstance(tiff_bits, int):
                tiff_bits = (tiff_bits,)
            high_depth = source.format == "PNG" and len(data) > 24 and data[24] > 8
            if (high_depth or any(bits > 8 for bits in tiff_bits) or source_mode in ("F", "I")
                    or source_mode.startswith("I;16")):
                raise UnsupportedImageError("当前照片流程使用 8 位编码，请将高位深照片转换为带 ICC 的 8 位 sRGB 后上传")
            img = ImageOps.exif_transpose(source)
            source_width, source_height = img.size
            alpha = img.getchannel("A") if "A" in img.getbands() else None
            if img.mode == "P":
                rgba = img.convert("RGBA")
                alpha = rgba.getchannel("A") if "transparency" in img.info else None
                img = rgba.convert("RGB")
            elif img.mode not in ("RGB", "CMYK", "LAB", "L"):
                img = img.convert("RGB")
            if input_style == "VLOG":
                if source_mode not in ("RGB", "RGBA", "P"):
                    raise UnsupportedImageError("V-Log 需要 RGB 编码照片，请保留原始信号")
                img = img.convert("RGB")
                status, warning = "preserved_vlog", "保留 V-Log / V-Gamut 原编码，未按 ICC 转换；请核对照片确为 V-Log。"
            elif icc:
                try:
                    profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
                    img = ImageCms.profileToProfile(
                        img, profile, ImageCms.ImageCmsProfile(io.BytesIO(srgb_profile())),
                        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB",
                    )
                except (ImageCms.PyCMSError, OSError, ValueError, TypeError) as exc:
                    raise UnsupportedImageError("ICC 配置无法转换，请先将照片转换为 sRGB 后上传") from exc
                status, warning = "converted_srgb", ""
            elif declared_adobe_rgb:
                img = adobe_rgb_to_srgb(img)
                status, warning = "converted_adobe_rgb", "按照片 EXIF 声明将 Adobe RGB 转换为 sRGB。"
            else:
                if img.mode in ("CMYK", "LAB") or color_space == 0xFFFF or interop in ("R03", b"R03"):
                    raise UnsupportedImageError("照片色彩空间未校准或为 Adobe RGB，缺少有效 ICC；请先转换为 sRGB 后上传")
                img = img.convert("RGB")
                status = "declared_srgb" if color_space == 1 else "assumed_srgb"
                warning = "" if color_space == 1 else "照片没有 ICC 色彩配置，按 sRGB 解释；如原图为其他色彩空间，请先转换为 sRGB。"
            if alpha is not None:
                matte = Image.new("RGB", img.size, (0, 0, 0))
                matte.paste(img, mask=alpha)
                img = matte
                warning = "；".join(filter(None, (warning, "透明区域已合成黑色背景。")))
            if max_side is not None:
                img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
            metadata = {
                "camera_make": _camera_text(exif.get(0x010F)),
                "camera_model": _camera_text(exif.get(0x0110)),
                "color_space": "Adobe RGB" if declared_adobe_rgb else "sRGB" if color_space == 1 else "uncalibrated" if color_space == 0xFFFF else "unknown",
                "embedded_icc": bool(icc),
                "source_width": source_width, "source_height": source_height,
                "width": img.width, "height": img.height,
                "color_management": {
                    "version": COLOR_VERSION, "input_style": input_style,
                    "working_space": "VLOG/V-Gamut" if input_style == "VLOG" else "sRGB",
                    "status": status, "warning": warning,
                },
            }
            # 创建像素图以移除 EXIF、GPS、XMP 以及来源 ICC。
            clean = img.copy()
            clean.info.clear()
            return DecodedPhoto(clean, metadata)
    except (ImageTooLargeError, UnsupportedImageError):
        raise
    except Image.DecompressionBombError as exc:
        raise ImageTooLargeError("图片超过 6400 万像素，请先缩小") from exc
    except Exception as exc:
        raise CorruptImageError("图片无法解码，请检查文件是否完整") from exc


def encode_preview(photo: DecodedPhoto) -> bytes:
    output = io.BytesIO()
    options = {} if photo.metadata["color_management"]["input_style"] == "VLOG" else {"icc_profile": srgb_profile()}
    photo.image.save(output, format="PNG", **options)
    return output.getvalue()


def photo_array(data: bytes, input_style: str = "STD", *, max_pixels=None) -> np.ndarray:
    photo = decode_photo(data, input_style, max_pixels=max_pixels)
    return np.ascontiguousarray(np.asarray(photo.image, dtype=np.float32) / 255.0)


def display_rgb(image: np.ndarray, input_style: str = "STD") -> np.ndarray:
    """LUT 输出编码转换到静态 sRGB 显示，不重复输入转换与显示映射。"""
    pixels = np.clip(np.asarray(image, dtype=np.float32), 0.0, 1.0)
    return srgb_oetf(rec709_eotf(pixels)).astype(np.float32) if input_style == "VLOG" else pixels
