import pytest
from fastapi.testclient import TestClient

from storage import db
from api.main import app


@pytest.fixture(autouse=True)
def _clean():
    db.init_db()
    db.clear_all()
    db.clear_users()
    db.clear_sessions()
    yield
    db.clear_all()
    db.clear_users()
    db.clear_sessions()


@pytest.fixture()
def auth():
    r = client.post("/api/auth/register", json={"username": "u1", "password": "*********"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


client = TestClient(app)


def test_session_crud(auth):
    r = client.post("/api/sessions", json={"title": "第一个会话"}, headers=auth)
    assert r.status_code == 200
    sid = r.json()["id"]

    r2 = client.get("/api/sessions", headers=auth)
    assert r2.status_code == 200
    assert len(r2.json()) == 1
    assert r2.json()[0]["title"] == "第一个会话"

    assert client.delete(f"/api/sessions/{sid}", headers=auth).status_code == 204
    assert len(client.get("/api/sessions", headers=auth).json()) == 0


def test_session_requires_auth():
    assert client.get("/api/sessions").status_code == 401


def test_messages_list(auth):
    user = db.get_user_by_username("u1")
    sid = client.post("/api/sessions", json={"title": "t"}, headers=auth).json()["id"]
    db.add_message(user["id"], sid, "user", "你好", None)
    db.add_message(user["id"], sid, "agent", "想要什么效果", '{"base_photo_style": "STD"}')

    r = client.get(f"/api/sessions/{sid}/messages", headers=auth)
    assert r.status_code == 200
    msgs = r.json()
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[1]["role"] == "agent"
    assert msgs[1]["params"]["base_photo_style"] == "STD"


def test_session_isolation():
    r1 = client.post("/api/auth/register", json={"username": "a", "password": "*********"}).json()
    r2 = client.post("/api/auth/register", json={"username": "b", "password": "*********"}).json()
    h1 = {"Authorization": f"Bearer {r1['token']}"}
    h2 = {"Authorization": f"Bearer {r2['token']}"}

    sid = client.post("/api/sessions", json={"title": "a的会话"}, headers=h1).json()["id"]
    assert len(client.get("/api/sessions", headers=h1).json()) == 1
    assert len(client.get("/api/sessions", headers=h2).json()) == 0
    assert client.get(f"/api/sessions/{sid}/messages", headers=h2).status_code == 404


def test_chat_with_invalid_session_404(auth):
    r = client.post("/api/session/chat", json={"message": "你好", "session_id": 99999}, headers=auth)
    assert r.status_code == 404
