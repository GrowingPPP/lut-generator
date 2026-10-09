from api.auth import create_token
import pytest
from fastapi.testclient import TestClient

from storage import db
from api.main import app


@pytest.fixture(autouse=True)
def _clean_db():
    db.init_db()
    db.clear_all()
    db.clear_users()
    yield
    db.clear_all()
    db.clear_users()


@pytest.fixture()
def auth():
    r = client.post("/api/auth/register", json={"username": "u1", "password": "*********"})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {create_token(r.json()['user_id'], 0)}"}


client = TestClient(app)


def test_create_and_list(auth):
    resp = client.post("/api/luts", json={
        "name": "日系清透",
        "description": "清透高调",
        "params": {"base_photo_style": "STD", "temp": 520.0, "contrast": -0.08},
    }, headers=auth)
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "日系清透"
    assert data["params"]["temp"] == 520.0

    resp = client.get("/api/luts", headers=auth)
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_download_camera_has_photo_style(auth):
    created = client.post("/api/luts", json={"name": "t", "params": {"base_photo_style": "STD"}}, headers=auth).json()
    resp = client.get(f"/api/luts/{created['id']}/download?mode=camera", headers=auth)
    assert resp.status_code == 200
    assert "#LUMIXPHOTOSTYLE STD" in resp.text
    assert "LUT_3D_SIZE 33" in resp.text


def test_download_software_no_photo_style(auth):
    created = client.post("/api/luts", json={"name": "t", "params": {"base_photo_style": "STD"}}, headers=auth).json()
    resp = client.get(f"/api/luts/{created['id']}/download?mode=software", headers=auth)
    assert resp.status_code == 200
    assert "#LUMIXPHOTOSTYLE" not in resp.text


def test_software_download_identifies_vlog_signal_contract(auth):
    created = client.post("/api/luts", json={
        "name": "look", "params": {"base_photo_style": "VLOG"},
    }, headers=auth).json()
    resp = client.get(f"/api/luts/{created['id']}/download?mode=software", headers=auth)
    assert resp.status_code == 200
    assert resp.text.startswith('TITLE "look [VLOG/V-Gamut -> Rec709]"')
    assert "VLOG_to_Rec709.cube" in resp.headers["content-disposition"]
    assert "#LUMIXPHOTOSTYLE" not in resp.text


def test_update_and_delete(auth):
    created = client.post("/api/luts", json={"name": "old", "params": {}}, headers=auth).json()
    lut_id = created["id"]
    resp = client.put(f"/api/luts/{lut_id}", json={"name": "new"}, headers=auth)
    assert resp.status_code == 200
    assert resp.json()["name"] == "new"

    resp = client.delete(f"/api/luts/{lut_id}", headers=auth)
    assert resp.status_code == 204
    assert client.get(f"/api/luts/{lut_id}", headers=auth).status_code == 404


def test_lut_requires_auth():
    resp = client.get("/api/luts")
    assert resp.status_code == 401


def test_user_isolation():
    r1 = client.post("/api/auth/register", json={"username": "a", "password": "*********"}).json()
    r2 = client.post("/api/auth/register", json={"username": "b", "password": "*********"}).json()
    h1 = {"Authorization": f"Bearer {create_token(r1['user_id'], 0)}"}
    h2 = {"Authorization": f"Bearer {create_token(r2['user_id'], 0)}"}

    client.post("/api/luts", json={"name": "only-a", "params": {}}, headers=h1)
    assert len(client.get("/api/luts", headers=h1).json()) == 1
    assert len(client.get("/api/luts", headers=h2).json()) == 0


def test_rgb_length_validation(auth):
    for key in ("lift", "gamma", "gain"):
        resp = client.post("/api/luts", json={"name": "t", "params": {key: [0.1, 0.2]}}, headers=auth)
        assert resp.status_code == 422, f"{key} 长度 2 未拒绝"
        resp = client.post("/api/luts", json={"name": "t", "params": {key: [0.1, 0.2, 0.3, 0.4]}}, headers=auth)
        assert resp.status_code == 422, f"{key} 长度 4 未拒绝"


def test_invalid_base_photo_style_422(auth):
    resp = client.post("/api/luts", json={"name": "t", "params": {"base_photo_style": "XYZ"}}, headers=auth)
    assert resp.status_code == 422
