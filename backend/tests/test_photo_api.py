"""照片 HTTP 边界；认证替身避免测试改动用户数据。"""
import hashlib
import io
import json
import struct
import zlib

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, ImageOps

from api import auth
from api.photos import router
from photo.color_management import srgb_profile


def photo_bytes():
    output = io.BytesIO()
    Image.new("RGB", (7, 4), (80, 100, 130)).save(output, "PNG")
    return output.getvalue()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"id": 991, "username": "photo_test"}
    return TestClient(app)


def test_normalize_returns_lossless_png_with_bounded_metadata(client):
    raw = photo_bytes()
    response = client.post("/api/photos/normalize", files={"file": ("source.png", raw)}, data={"input_style": "STD"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "no-store"
    metadata = json.loads(response.headers["x-photo-metadata"])
    assert metadata["source_digest"] == hashlib.sha256(raw).hexdigest()
    assert metadata["source_width"] == 7 and metadata["source_height"] == 4
    assert metadata["color_management"]["version"] == 1
    assert "gps" not in json.dumps(metadata).lower()
    assert Image.open(io.BytesIO(response.content)).getpixel((0, 0)) == (80, 100, 130)


def test_original_normalization_preserves_oriented_pixels_without_changing_preview(client):
    pixels = np.arange(3001 * 13 * 3, dtype=np.uint32).reshape(13, 3001, 3).astype(np.uint8)
    source = Image.fromarray(pixels)
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x010F] = "Orientation test camera"
    buffer = io.BytesIO()
    source.save(buffer, "PNG", exif=exif, icc_profile=srgb_profile())
    raw = buffer.getvalue()
    expected = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    results = {}
    for resolution in (None, "preview", "original"):
        response = client.post("/api/photos/normalize", files={"file": ("source.png", raw)},
            data={"input_style": "STD", **({"resolution": resolution} if resolution else {})})
        assert response.status_code == 200
        metadata = json.loads(response.headers["x-photo-metadata"])
        image = Image.open(io.BytesIO(response.content))
        assert metadata["source_digest"] == hashlib.sha256(raw).hexdigest()
        assert (metadata["source_width"], metadata["source_height"]) == (13, 3001)
        assert (metadata["width"], metadata["height"]) == image.size
        assert metadata["color_management"]["status"] == "converted_srgb"
        assert image.info["icc_profile"] == srgb_profile()
        assert not image.getexif()
        results[resolution] = image
    assert results["original"].size == expected.size == (13, 3001)
    assert np.array_equal(np.asarray(results["original"]), np.asarray(expected))
    expected.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
    assert np.array_equal(np.asarray(results["preview"]), np.asarray(expected))
    assert np.array_equal(np.asarray(results[None]), np.asarray(expected))


@pytest.mark.parametrize("input_style", ["STD", "VLOG"])
def test_original_normalization_reuses_adobe_rgb_conversion_and_vlog_preservation(client, input_style):
    from photo.adobe_rgb import adobe_rgb_to_srgb
    source = Image.new("RGB", (3001, 3), (80, 160, 60))
    exif = Image.Exif()
    exif[0x0112] = 6
    exif[0x8769] = {0xA001: 0xFFFF, 0xA005: {1: "R03"}}
    buffer = io.BytesIO()
    source.save(buffer, "JPEG", quality=100, subsampling=0, exif=exif)
    raw = buffer.getvalue()
    expected = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    if input_style == "STD":
        expected = adobe_rgb_to_srgb(expected)
    response = client.post("/api/photos/normalize", files={"file": ("source.jpg", raw)},
        data={"input_style": input_style, "resolution": "original"})
    assert response.status_code == 200
    metadata = json.loads(response.headers["x-photo-metadata"])
    image = Image.open(io.BytesIO(response.content))
    assert image.size == (3, 3001)
    assert np.array_equal(np.asarray(image), np.asarray(expected))
    assert bool(image.info.get("icc_profile")) == (input_style == "STD")
    assert metadata["color_management"]["status"] == (
        "converted_adobe_rgb" if input_style == "STD" else "preserved_vlog")


@pytest.mark.parametrize("resolution", ["preview", "original"])
def test_normalization_keeps_64mp_and_32mb_guards_for_both_resolutions(client, resolution):
    # A valid PNG header reports >64MP; reject before allocating its pixel buffer.
    raw = bytearray(photo_bytes())
    raw[16:24] = struct.pack(">II", 8001, 8000)
    raw[29:33] = struct.pack(">I", zlib.crc32(raw[12:29]) & 0xFFFFFFFF)
    response = client.post("/api/photos/normalize", files={"file": ("oversize.png", bytes(raw))},
        data={"resolution": resolution})
    assert response.status_code == 413
    assert "64,000,000" in response.json()["detail"]
    response = client.post("/api/photos/normalize", files={"file": ("source.png", photo_bytes())},
        data={"resolution": resolution}, headers={"content-length": str(34 * 1024 * 1024)})
    assert response.status_code == 413


def test_original_normalization_keeps_actual_upload_size_guard(client, monkeypatch):
    from api import photos
    assert photos.MAX_PHOTO_BYTES == 32 * 1024 * 1024
    raw = photo_bytes()
    monkeypatch.setattr(photos, "MAX_PHOTO_BYTES", len(raw) - 1)
    response = client.post("/api/photos/normalize", files={"file": ("source.png", raw)},
        data={"resolution": "original"})
    assert response.status_code == 413


def test_normalization_rejects_unknown_resolution(client):
    response = client.post("/api/photos/normalize", files={"file": ("source.png", photo_bytes())},
        data={"resolution": "unbounded"})
    assert response.status_code == 422


@pytest.mark.parametrize("resolution", ["preview", "original"])
def test_photo_routes_require_authentication(resolution):
    app = FastAPI()
    app.include_router(router)
    response = TestClient(app).post("/api/photos/normalize", files={"file": ("source.png", photo_bytes())},
        data={"resolution": resolution})
    assert response.status_code == 401


def test_export_checks_original_source_and_validates_params(client):
    raw = photo_bytes()
    base = {"source_digest": hashlib.sha256(raw).hexdigest(), "params": json.dumps({}), "format": "png"}
    response = client.post("/api/photos/export", files={"file": ("source.png", raw)}, data=base)
    assert response.status_code == 200
    assert response.headers["x-photo-width"] == "7"
    assert response.headers["x-photo-color-space"] == "sRGB"
    assert "source_adjusted_sRGB.png" in response.headers["content-disposition"]
    assert Image.open(io.BytesIO(response.content)).size == (7, 4)
    response = client.post("/api/photos/export", files={"file": ("source.png", raw)}, data={**base, "source_digest": "0" * 64})
    assert response.status_code == 409
    for params in ["{", '{"exposure":99}', '{"unexpected":1}']:
        response = client.post("/api/photos/export", files={"file": ("source.png", raw)}, data={**base, "params": params})
        assert response.status_code == 422


@pytest.mark.parametrize("resolution", ["preview", "original"])
def test_normalize_rejects_invalid_input_and_content(client, resolution):
    response = client.post("/api/photos/normalize", files={"file": ("source.png", b"garbage")},
        data={"resolution": resolution})
    assert response.status_code == 400
    response = client.post("/api/photos/normalize", files={"file": ("source.png", photo_bytes())},
        data={"input_style": "AUTO", "resolution": resolution})
    assert response.status_code == 422


def test_declared_upload_size_is_bounded_before_decode(client):
    response = client.post("/api/photos/normalize", files={"file": ("source.png", photo_bytes())}, headers={"content-length": str(34 * 1024 * 1024)})
    assert response.status_code == 413


def test_processing_capacity_returns_retryable_error(client):
    from api.photos import _slots
    _slots.acquire()
    _slots.acquire()
    try:
        response = client.post("/api/photos/normalize", files={"file": ("source.png", photo_bytes())})
        assert response.status_code == 429
    finally:
        _slots.release()
        _slots.release()


def test_export_resolves_external_lut_with_current_owner_and_applies_free_curve(client, monkeypatch):
    from lut_engine import ImportedLut, build_grid, identity_curves
    from photo import render as R
    from storage import db
    identifier = "65e37976-4732-49bb-b0b9-6560437f5ba4"
    grid = (1 - build_grid(2)).astype(np.float32)
    record = {"size": 2, "grid_blob": grid.transpose(2, 1, 0, 3).astype("<f4").tobytes(),
              "domain_min_json": "[0,0,0]", "domain_max_json": "[1,1,1]", "title": "Invert",
              "input_encoding": "sRGB", "output_encoding": "sRGB"}
    owners = []
    monkeypatch.setattr(db, "get_imported_lut", lambda key, owner: owners.append((key, owner)) or record)
    curves = identity_curves()
    curves["master"] = [[0, .1], [.5, .6], [1, 1]]
    params = {"curve_points": curves, "external_lut_id": identifier, "external_lut_strength": .5}
    raw = photo_bytes()
    response = client.post("/api/photos/export", files={"file": ("source.png", raw)},
        data={"params": json.dumps(params), "source_digest": hashlib.sha256(raw).hexdigest(), "format": "png"})
    assert response.status_code == 200
    assert owners == [(identifier, 991)]
    source = np.asarray(Image.open(io.BytesIO(raw)), dtype=np.float32) / 255
    expected = R.render_lut(R.lut_from_params(params, resolver=lambda _: ImportedLut(2, grid)), source)
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(response.content))), (expected * 255 + .5).astype(np.uint8))


def test_export_does_not_silently_ignore_missing_or_foreign_external_lut(client, monkeypatch):
    from storage import db
    monkeypatch.setattr(db, "get_imported_lut", lambda *_: None)
    raw = photo_bytes()
    response = client.post("/api/photos/export", files={"file": ("source.png", raw)},
        data={"params": json.dumps({"external_lut_id": "65e37976-4732-49bb-b0b9-6560437f5ba4", "external_lut_strength": 1}),
              "source_digest": hashlib.sha256(raw).hexdigest(), "format": "png"})
    assert response.status_code == 404
