import pytest
from fastapi.testclient import TestClient

from storage import db
from api.main import app


@pytest.fixture(autouse=True)
def _clean_db():
    db.init_db()
    db.clear_all()
    yield
    db.clear_all()


client = TestClient(app)


def test_create_and_list():
    resp = client.post("/api/luts", json={
        "name": "日系清透",
        "description": "清透高调",
        "params": {"base_photo_style": "STD", "temp": 520.0, "contrast": -0.08},
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "日系清透"
    assert data["params"]["temp"] == 520.0

    resp = client.get("/api/luts")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_download_camera_has_photo_style():
    created = client.post("/api/luts", json={"name": "t", "params": {"base_photo_style": "STD"}}).json()
    resp = client.get(f"/api/luts/{created['id']}/download?mode=camera")
    assert resp.status_code == 200
    assert "#LUMIXPHOTOSTYLE STD" in resp.text
    assert "LUT_3D_SIZE 33" in resp.text


def test_download_software_no_photo_style():
    created = client.post("/api/luts", json={"name": "t", "params": {"base_photo_style": "STD"}}).json()
    resp = client.get(f"/api/luts/{created['id']}/download?mode=software")
    assert resp.status_code == 200
    assert "#LUMIXPHOTOSTYLE" not in resp.text


def test_update_and_delete():
    created = client.post("/api/luts", json={"name": "old", "params": {}}).json()
    lut_id = created["id"]
    resp = client.put(f"/api/luts/{lut_id}", json={"name": "new"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "new"

    resp = client.delete(f"/api/luts/{lut_id}")
    assert resp.status_code == 204
    assert client.get(f"/api/luts/{lut_id}").status_code == 404


def test_rgb_length_validation():
    # lift/gamma/gain 必须是三元组,长度 2 或 4 都应被 API 拒绝(422)
    for key in ("lift", "gamma", "gain"):
        resp = client.post("/api/luts", json={"name": "t", "params": {key: [0.1, 0.2]}})
        assert resp.status_code == 422, f"{key} 长度 2 未拒绝"
        resp = client.post("/api/luts", json={"name": "t", "params": {key: [0.1, 0.2, 0.3, 0.4]}})
        assert resp.status_code == 422, f"{key} 长度 4 未拒绝"


def test_invalid_base_photo_style_422():
    resp = client.post("/api/luts", json={"name": "t", "params": {"base_photo_style": "XYZ"}})
    assert resp.status_code == 422
