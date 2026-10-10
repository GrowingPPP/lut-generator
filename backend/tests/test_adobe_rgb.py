"""Adobe RGB (1998) 标准编码转换的数值与资源边界验证。"""
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageCms

from photo.adobe_rgb import adobe_rgb_to_srgb
from photo.types import UnsupportedImageError


def color_image(values):
    return Image.fromarray(np.asarray(values, dtype=np.uint8).reshape(1, -1, 3))


def test_primary_colors_and_endpoints_are_clipped_without_byte_wraparound():
    values = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0],
              [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]
    actual = np.asarray(adobe_rgb_to_srgb(color_image(values)))
    np.testing.assert_array_equal(actual[0], values)


def test_known_mixed_colors_are_converted_rather_than_reinterpreted_as_srgb():
    # 标准 D65 原色矩阵及 563/256 解码，再以 sRGB 分段函数编码的数值样本。
    values = [[128, 64, 32], [0, 128, 0], [255, 128, 0], [12, 8, 6],
              [100, 160, 200], [200, 100, 160], [32, 16, 8]]
    expected = [[146, 62, 23], [0, 129, 0], [255, 129, 0], [5, 2, 1],
                [53, 161, 203], [227, 100, 163], [31, 7, 1]]
    actual = np.asarray(adobe_rgb_to_srgb(color_image(values)))[0]
    np.testing.assert_array_equal(actual, expected)
    assert not np.array_equal(actual, values)


def test_neutral_ramp_stays_neutral_and_uses_adobe_gamma_including_dark_values():
    levels = np.arange(256, dtype=np.uint8)
    values = np.repeat(levels[:, None], 3, axis=1)
    actual = np.asarray(adobe_rgb_to_srgb(color_image(values)))[0]
    linear = (levels.astype(np.float64) / 255) ** (563 / 256)
    expected = np.where(linear <= 0.0031308, 12.92 * linear,
                        1.055 * linear ** (1 / 2.4) - 0.055)
    np.testing.assert_array_equal(actual[:, 0], (expected * 255 + 0.5).astype(np.uint8))
    np.testing.assert_array_equal(actual[:, 0], actual[:, 1])
    np.testing.assert_array_equal(actual[:, 1], actual[:, 2])
    assert actual[32, 0] == 26 and actual[128, 0] == 129


@pytest.mark.parametrize("tile_pixels", [1, 7, 23, 100, 10_000])
def test_conversion_is_invariant_to_tiles_and_preserves_dimensions(tile_pixels):
    values = np.random.default_rng(98).integers(0, 256, (13, 23, 3), dtype=np.uint8)
    image = Image.fromarray(values)
    actual = adobe_rgb_to_srgb(image, tile_pixels=tile_pixels)
    assert actual.mode == "RGB" and actual.size == image.size
    np.testing.assert_array_equal(actual, adobe_rgb_to_srgb(image))
    np.testing.assert_array_equal(image, values)


def test_float_scratch_is_bounded_even_for_a_row_wider_than_the_tile(monkeypatch):
    import photo.adobe_rgb as module

    real_encode = module.srgb_oetf
    shapes = []

    def record_encode(values):
        shapes.append(values.shape)
        return real_encode(values)

    monkeypatch.setattr(module, "srgb_oetf", record_encode)
    result = adobe_rgb_to_srgb(Image.new("RGB", (31, 5), (128, 64, 32)), tile_pixels=7)
    assert result.size == (31, 5)
    assert shapes and all(h * w <= 7 and channels == 3 for h, w, channels in shapes)
    assert sum(h * w for h, w, _ in shapes) == 31 * 5


def test_conversion_creates_pixels_without_source_metadata_or_mutating_input():
    image = Image.new("RGB", (4, 3), (128, 64, 32))
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x013B] = "Private Photographer"
    image.info.update(icc_profile=b"source-profile", exif=exif.tobytes(), xmp=b"private-location")
    before = image.info.copy()
    output = adobe_rgb_to_srgb(image)
    assert output is not image and output.size == image.size
    assert output.info == {} and not output.getexif()
    assert image.info == before and image.getpixel((0, 0)) == (128, 64, 32)
    encoded = io.BytesIO()
    output.save(encoded, "PNG")
    reopened = Image.open(io.BytesIO(encoded.getvalue()))
    assert not reopened.getexif()
    assert not {"icc_profile", "exif", "xmp"}.intersection(reopened.info)


@pytest.mark.parametrize("mode", ["L", "RGBA", "CMYK", "LAB", "I;16", "F", "P"])
def test_non_rgb_modes_are_rejected_without_implicit_reinterpretation(mode):
    with pytest.raises(UnsupportedImageError, match="8 位 RGB"):
        adobe_rgb_to_srgb(Image.new(mode, (1, 1)))


@pytest.mark.parametrize("tile_pixels", [0, -1, True, 1.5, None])
def test_invalid_tile_budget_is_rejected(tile_pixels):
    with pytest.raises(ValueError, match="正整数"):
        adobe_rgb_to_srgb(Image.new("RGB", (1, 1)), tile_pixels=tile_pixels)


def test_standard_transform_matches_existing_system_icc_within_one_8bit_code():
    path = Path("/System/Library/ColorSync/Profiles/AdobeRGB1998.icc")
    if not path.is_file():
        pytest.skip("本机没有标准 Adobe RGB (1998) ICC 对照配置")
    values = np.linspace(0, 255, 17).astype(np.uint8)
    colors = np.stack(np.meshgrid(values, values, values, indexing="ij"), axis=-1).reshape(-1, 3)
    source = color_image(colors)
    profile = ImageCms.getOpenProfile(str(path))
    assert "Adobe RGB (1998)" in ImageCms.getProfileDescription(profile)
    oracle = ImageCms.profileToProfile(
        source, profile, ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")),
        renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC, outputMode="RGB",
    )
    delta = np.abs(np.asarray(adobe_rgb_to_srgb(source)).astype(np.int16)
                   - np.asarray(oracle).astype(np.int16))
    # ICC 定点矩阵及 8 位变换量化允许最后一个编码值的差异。
    assert np.max(delta) <= 1
