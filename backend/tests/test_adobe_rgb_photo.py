"""无 ICC 但有明确 Adobe RGB EXIF 声明的照片契约。"""
import io

import numpy as np
import pytest
from PIL import Image

from photo.color_management import decode_photo, encode_preview, photo_array
from photo.export import export_photo
from photo.types import UnsupportedImageError


def declared_photo(*, color_space=0xFFFF, interop="R03", icc=None):
    image = Image.new("RGB", (5, 3), (80, 160, 60))
    exif = Image.Exif()
    tags = {0xA001: color_space}
    if interop is not None:
        tags[0xA005] = {1: interop}
    exif[0x8769] = tags
    output = io.BytesIO()
    image.save(output, "JPEG", quality=100, subsampling=0, exif=exif, **({"icc_profile": icc} if icc is not None else {}))
    return output.getvalue()


def test_declared_adobe_rgb_without_icc_is_converted_for_preview_and_analysis():
    raw = declared_photo()
    before = Image.open(io.BytesIO(raw)).getpixel((0, 0))
    result = decode_photo(raw)
    assert result.metadata["color_management"]["status"] == "converted_adobe_rgb"
    assert result.metadata["color_space"] == "Adobe RGB"
    assert result.metadata["embedded_icc"] is False
    assert result.image.size == (5, 3)
    assert result.image.getpixel((0, 0)) != before
    assert np.array_equal(photo_array(raw), photo_array(encode_preview(result)))


@pytest.mark.parametrize("color_space,interop", [(0xFFFF, None), (0xFFFF, "unknown"), (1, "R03")])
def test_adobe_rgb_conversion_requires_consistent_explicit_declaration(color_space, interop):
    with pytest.raises(UnsupportedImageError):
        decode_photo(declared_photo(color_space=color_space, interop=interop))


def test_invalid_embedded_icc_does_not_fall_back_to_exif_declaration():
    with pytest.raises(UnsupportedImageError, match="ICC"):
        decode_photo(declared_photo(icc=b"invalid-icc"))


def test_declared_adobe_rgb_vlog_retains_signal_values():
    raw = declared_photo()
    before = np.array(Image.open(io.BytesIO(raw)))
    result = decode_photo(raw, "VLOG")
    assert np.array_equal(np.asarray(result.image), before)
    assert result.metadata["color_management"]["status"] == "preserved_vlog"


def test_declared_adobe_rgb_export_uses_normalized_main_photo():
    raw = declared_photo()
    result = export_photo(raw, {}, output_format="png")
    output = Image.open(io.BytesIO(result.data))
    assert output.size == (5, 3)
    assert output.info.get("icc_profile")
    assert not output.getexif()
