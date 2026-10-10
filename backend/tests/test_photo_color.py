"""ICC、方向、编码域及原分辨率导出的契约验证。"""
import io
import struct

import numpy as np
import pytest
from PIL import Image, ImageCms, ImageOps

from lut_engine.colorspace import rec709_eotf, srgb_oetf
from photo.color_management import decode_photo, encode_preview, photo_array, srgb_profile
from photo.export import export_photo
from photo.render import lut_from_params, render_lut
from photo.types import UnsupportedImageError


def encoded(image, *, icc=None, exif=None, format="PNG"):
    out = io.BytesIO()
    options = {}
    if icc is not None:
        options["icc_profile"] = icc
    if exif is not None:
        options["exif"] = exif
    image.save(out, format, **options)
    return out.getvalue()


def linear_rgb_profile():
    """与 sRGB 相同原色，使用线性传递函数的测试配置。"""
    profile = bytearray(srgb_profile())
    count = struct.unpack_from(">I", profile, 128)[0]
    for i in range(count):
        signature, offset, _ = struct.unpack_from(">4sII", profile, 132 + i * 12)
        if signature in (b"rTRC", b"gTRC", b"bTRC"):
            struct.pack_into(">4sIHHI", profile, offset, b"para", 0, 0, 0, 65536)
    return bytes(profile)


def test_icc_conversion_changes_linear_encoded_pixels_and_is_shared_with_preview():
    raw = encoded(Image.new("RGB", (4, 3), (128, 64, 32)), icc=linear_rgb_profile())
    result = decode_photo(raw)
    rgb = np.asarray(result.image)[0, 0]
    assert rgb[0] > 175 and rgb[1] > 125 and rgb[2] > 90
    assert result.metadata["color_management"]["status"] == "converted_srgb"
    normalized = encode_preview(result)
    assert np.array_equal(photo_array(raw), photo_array(normalized))
    assert np.array_equal(np.asarray(result.image), (photo_array(raw) * 255 + .5).astype(np.uint8))


def test_direction_applied_once_and_source_metadata_is_not_embedded():
    values = np.arange(18, dtype=np.uint8).reshape(3, 2, 3) * 10
    image = Image.fromarray(values, "RGB")
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x010F] = "Test Camera\x00"
    exif[0x013B] = "Private Photographer"
    raw = encoded(image, exif=exif)
    expected = np.asarray(ImageOps.exif_transpose(Image.open(io.BytesIO(raw))))
    result = decode_photo(raw)
    assert result.image.size == (3, 2)
    assert result.metadata["source_width"] == 3
    assert result.metadata["source_height"] == 2
    assert result.metadata["camera_make"] == "Test Camera"
    assert np.array_equal(np.asarray(result.image), expected)
    preview = Image.open(io.BytesIO(encode_preview(result)))
    assert not preview.getexif()
    assert "exif" not in preview.info
    assert preview.info["icc_profile"] == srgb_profile()


def test_preview_and_backend_analysis_share_resized_pixels():
    x = np.arange(3001, dtype=np.uint16) % 256
    pixels = np.tile(np.stack((x, 255 - x, x // 2), -1).astype(np.uint8), (8, 1, 1))
    raw = encoded(Image.fromarray(pixels, "RGB"))
    result = decode_photo(raw)
    assert result.image.width == 2048
    assert result.metadata["source_width"] == 3001
    assert np.array_equal(photo_array(raw), photo_array(encode_preview(result)))


def test_vlog_does_not_apply_icc_or_label_input_as_srgb():
    raw = encoded(Image.new("RGB", (2, 2), (128, 64, 32)), icc=linear_rgb_profile())
    result = decode_photo(raw, "VLOG")
    assert result.image.getpixel((0, 0)) == (128, 64, 32)
    assert result.metadata["color_management"]["status"] == "preserved_vlog"
    assert "icc_profile" not in Image.open(io.BytesIO(encode_preview(result))).info
    assert np.array_equal(photo_array(raw, "VLOG"), photo_array(encode_preview(result), "VLOG"))


def test_untagged_rgb_is_an_explicit_assumption_not_inferred_photo_style():
    result = decode_photo(encoded(Image.new("RGB", (2, 2), (10, 20, 30))), "NAT")
    assert result.metadata["color_management"]["status"] == "assumed_srgb"
    assert "按 sRGB" in result.metadata["color_management"]["warning"]
    assert result.metadata["color_management"]["input_style"] == "NAT"
    assert result.image.getpixel((0, 0)) == (10, 20, 30)


@pytest.mark.parametrize("case", ["bad_icc", "cmyk", "uncalibrated", "deep_png", "animated"])
def test_ambiguous_or_unsupported_encoding_is_rejected(case):
    if case == "bad_icc":
        raw = encoded(Image.new("RGB", (2, 2)), icc=b"not-an-icc")
    elif case == "cmyk":
        raw = encoded(Image.new("CMYK", (2, 2)), format="JPEG")
    elif case == "uncalibrated":
        exif = Image.Exif()
        exif[0xA001] = 65535
        raw = encoded(Image.new("RGB", (2, 2)), exif=exif)
    elif case == "deep_png":
        raw = encoded(Image.fromarray(np.full((2, 2), 32768, np.uint16)))
    else:
        out = io.BytesIO()
        image = Image.new("RGB", (2, 2))
        image.save(out, "PNG", save_all=True, append_images=[Image.new("RGB", (2, 2), "red")])
        raw = out.getvalue()
    with pytest.raises(UnsupportedImageError):
        decode_photo(raw)


def test_alpha_is_consistently_flattened_to_black():
    result = decode_photo(encoded(Image.new("RGBA", (2, 2), (200, 100, 50, 128))))
    assert result.image.getpixel((0, 0)) == (100, 50, 25)
    assert "透明区域" in result.metadata["color_management"]["warning"]


def test_statistics_pixel_limit_is_enforced_by_canonical_decoder(monkeypatch):
    from photo import stats
    from photo.types import ImageTooLargeError
    raw = encoded(Image.new("RGB", (40, 30)))
    monkeypatch.setattr(stats, "MAX_PIXELS", 1000)
    with pytest.raises(ImageTooLargeError):
        stats.load_image(raw)



def test_export_preserves_oriented_source_resolution_and_strips_private_metadata():
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x013B] = "Private Photographer"
    raw = encoded(Image.new("RGB", (3001, 8), (80, 110, 140)), exif=exif)
    result = export_photo(raw, {"base_photo_style": "STD"}, output_format="png")
    image = Image.open(io.BytesIO(result.data))
    assert result.width == 8 and result.height == 3001
    assert image.size == (8, 3001)
    assert image.getpixel((0, 0)) == (80, 110, 140)
    assert image.info["icc_profile"] == srgb_profile()
    assert not image.getexif()


def test_export_uses_trilinear_lut_not_preview_and_is_invariant_to_tile_size(monkeypatch):
    rng = np.random.default_rng(12)
    pixels = rng.integers(0, 256, (13, 19, 3), dtype=np.uint8)
    raw = encoded(Image.fromarray(pixels, "RGB"))
    params = {"contrast": .23, "temp": 280., "shadows": .19}
    expected = (render_lut(lut_from_params(params), pixels.astype(np.float32) / 255) * 255 + .5).astype(np.uint8)
    import photo.export as module
    monkeypatch.setattr(module, "TILE_PIXELS", 19)
    result = export_photo(raw, params, output_format="png")
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(result.data))), expected)


def test_vlog_photo_export_converts_only_display_transfer_to_srgb():
    pixels = np.array([[[100, 123, 144], [172, 156, 139], [72, 72, 72]]], np.uint8)
    raw = encoded(Image.fromarray(pixels, "RGB"), icc=linear_rgb_profile())
    params = {"base_photo_style": "VLOG", "tone_map": .75}
    output = render_lut(lut_from_params(params), pixels.astype(np.float32) / 255)
    expected = (srgb_oetf(rec709_eotf(output)) * 255 + .5).astype(np.uint8)
    result = export_photo(raw, params, output_format="png")
    image = Image.open(io.BytesIO(result.data))
    assert np.array_equal(np.asarray(image), expected)
    profile = ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"]))
    assert "sRGB" in ImageCms.getProfileDescription(profile)


@pytest.mark.parametrize("format", ["jpeg", "png"])
def test_export_format_and_color_label(format):
    raw = encoded(Image.new("RGB", (12, 9), (102, 80, 44)))
    result = export_photo(raw, {}, output_format=format, quality=98)
    image = Image.open(io.BytesIO(result.data))
    assert image.format == ("JPEG" if format == "jpeg" else "PNG")
    assert result.media_type == f"image/{format}"
    assert image.info["icc_profile"] == srgb_profile()


def test_vision_review_uses_srgb_display_without_reapplying_vlog_conversion(monkeypatch):
    from types import SimpleNamespace
    from agent import auto as A
    from photo.color_management import display_rgb
    before = np.full((2, 3, 3), .25, np.float32)
    after = np.full((2, 3, 3), .45, np.float32)
    panels = []
    monkeypatch.setattr(A.R, "to_data_url", lambda panel: panels.append(panel.copy()) or "data:image/jpeg;base64,test")
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs:
        SimpleNamespace(usage=None, choices=[SimpleNamespace(message=SimpleNamespace(content="复核完成"))]))))
    review, _, reason = A.vision_review(client, before, after, base_photo_style="VLOG")
    assert review == "复核完成" and reason is None
    assert np.array_equal(panels[0][:, :3], display_rgb(before, "VLOG"))
    assert np.array_equal(panels[0][:, -3:], display_rgb(after, "VLOG"))
    assert panels[0][0, 0, 0] > .25
