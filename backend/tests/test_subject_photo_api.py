"""人物识别 HTTP 边界：来源、方向、隐私和失败状态。"""
import hashlib
import io
import json
import numpy as np
import pytest
from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient
from api import auth, photos


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(photos.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"id": 999}
    monkeypatch.setattr(photos, "subject_client", lambda user, enabled: object() if enabled else None)
    return TestClient(app)


def upload(client, **data):
    buffer = io.BytesIO()
    exif = Image.Exif()
    exif[0x0112] = 6
    Image.new("RGB", (80, 40), (170, 100, 70)).save(buffer, "PNG", exif=exif)
    raw = buffer.getvalue()
    return client.post("/api/photos/subjects", files={"file": ("oriented.png", raw)},
                       data={"source_digest": hashlib.sha256(raw).hexdigest(), **data})


def test_subject_api_binds_original_source_and_oriented_display_coordinates(client, monkeypatch):
    seen = []
    def detect(_client, image, **kwargs):
        seen.append(image.copy())
        return {"version": "subject-regions-1", "status": "resolved", "subject_mode": "non_portrait",
                "confidence": .95, "regions": [], "source": "auto", "mask_mode": "skin_candidates"}, {}
    monkeypatch.setattr(photos, "detect_subjects", detect)
    result = upload(client)
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    assert seen[0].shape == (80, 40, 3)
    assert result.json()["input_style"] == "STD"
    assert len(result.json()["source_digest"]) == 64
    assert "image" not in result.json()


def test_disabled_api_does_not_create_or_call_model(client, monkeypatch):
    def forbidden(*args):
        raise AssertionError("no model should be created")
    monkeypatch.setattr("agent.llm.get_llm", forbidden)
    result = upload(client, enabled="false")
    assert result.status_code == 200
    assert result.json()["status"] == "disabled"
    assert result.json()["regions"] == []


@pytest.mark.parametrize("data,status", [({"source_digest": "a" * 64}, 409),
    ({"source_digest": "invalid"}, 422), ({"input_style": "invalid"}, 422),
    ({"tone_map": "2"}, 422), ({"params": "invalid"}, 422),
    ({"params": json.dumps({"base_photo_style": "VLOG"})}, 409)])
def test_invalid_source_or_input_never_reaches_model(client, monkeypatch, data, status):
    monkeypatch.setattr(photos, "detect_subjects", lambda *args, **kwargs: pytest.fail("invalid image reached model"))
    assert upload(client, **data).status_code == status


def test_model_error_exposes_failed_status_not_private_exception(client):
    result = upload(client)
    assert result.status_code == 200
    assert result.json()["status"] == "failed"
    assert result.json()["reason"] == "failed"


def test_subject_endpoint_requires_authentication():
    app = FastAPI()
    app.include_router(photos.router)
    with TestClient(app) as client:
        assert upload(client).status_code == 401


def test_closed_analysis_does_not_reserve_paid_budget(monkeypatch):
    monkeypatch.setattr("agent.llm.get_llm", lambda: pytest.fail("closed analysis created client"))
    assert photos.subject_client(999, False) is None
