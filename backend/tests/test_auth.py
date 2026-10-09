from api.auth import create_token
import pytest
from fastapi.testclient import TestClient

from storage import db
from api.main import app
from api import ratelimit


@pytest.fixture(autouse=True)
def _clean_users():
    db.init_db()
    db.clear_users()
    yield
    db.clear_users()


client = TestClient(app)


def test_register_and_login():
    r = client.post("/api/auth/register", json={"username": "alice", "password": "secret123"})
    assert r.status_code == 200
    data = r.json()
    assert data["username"] == "alice"
    assert "token" not in data
    assert r.cookies.get("chroma_token")
    assert "HttpOnly" in r.headers["set-cookie"]
    assert data["user_id"] > 0

    r2 = client.post("/api/auth/login", json={"username": "alice", "password": "secret123"})
    assert r2.status_code == 200
    assert r2.json()["user_id"] == data["user_id"]


def test_register_duplicate_409():
    client.post("/api/auth/register", json={"username": "bob", "password": "secret123"})
    r = client.post("/api/auth/register", json={"username": "bob", "password": "secret123"})
    assert r.status_code == 409


def test_login_wrong_password_401():
    client.post("/api/auth/register", json={"username": "carol", "password": "secret123"})
    r = client.post("/api/auth/login", json={"username": "carol", "password": "wrong"})
    assert r.status_code == 401


def test_login_unknown_user_401():
    r = client.post("/api/auth/login", json={"username": "nobody", "password": "x"})
    assert r.status_code == 401


def test_logout_invalidates_token():
    r = client.post("/api/auth/register", json={"username": "dave", "password": "secret123"})
    headers = {"Authorization": f"Bearer {create_token(r.json()['user_id'], 0)}"}
    assert client.get("/api/luts", headers=headers).status_code == 200

    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/luts", headers=headers).status_code == 401


def test_registration_has_shared_rate_limit():
    ratelimit.reset("testclient")
    for i in range(5):
        assert client.post("/api/auth/register", json={"username": f"new{i}", "password": "secret123"}).status_code == 200
    blocked = client.post("/api/auth/register", json={"username": "new5", "password": "secret123"})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0


def test_own_successful_login_cannot_reset_victim_attempts():
    ratelimit.reset("testclient")
    for name in ("victim", "attacker"):
        assert client.post("/api/auth/register", json={"username": name, "password": "secret123"}).status_code == 200
    for _ in range(4):
        assert client.post("/api/auth/login", json={"username": "victim", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "attacker", "password": "secret123"}).status_code == 200
    assert client.post("/api/auth/login", json={"username": "victim", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "victim", "password": "wrong"}).status_code == 429
