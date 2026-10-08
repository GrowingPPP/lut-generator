"""生成结果留档:chat 生成后 cube 文本落库,重开会话可凭 /generated 恢复参数并直接下载。"""
from unittest.mock import patch

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
    r = client.post("/api/auth/register", json={"username": "u1", "password": "secret123"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


client = TestClient(app)


def _chat(message, headers, **kwargs):
    """打桩 LLM:extract_result 返回 confirm,不触碰真实 API。"""
    with patch("agent.llm.get_llm", return_value=object()), \
         patch("agent.llm.extract_result", return_value={"intent": "confirm"}):
        return client.post("/api/session/chat", json={"message": message, **kwargs}, headers=headers)


def test_chat_generation_is_persisted(auth):
    r = _chat("确认", auth, params={"base_photo_style": "STD", "temp": 520.0})
    assert r.status_code == 200
    body = r.json()
    assert body["done"] is True
    assert body["cube_text"].startswith("TITLE")

    gen = client.get(f"/api/sessions/{body['session_id']}/generated", headers=auth)
    assert gen.status_code == 200
    data = gen.json()
    assert data["cube_text"] == body["cube_text"]
    assert data["params"]["temp"] == 520.0
    assert "#LUMIXPHOTOSTYLE STD" in data["cube_text"]


def test_restored_params_survive_resend(auth):
    """重开会话拿到的参数再发一轮,结果一致 —— 参数提取依赖 params 上下文,不能丢。"""
    first = _chat("确认", auth, params={"temp": 520.0}).json()
    gen = client.get(f"/api/sessions/{first['session_id']}/generated", headers=auth).json()
    params = gen["params"]

    second = _chat("再确认一次", auth, params=params, session_id=first["session_id"]).json()
    assert second["done"] is True
    assert second["params"]["temp"] == 520.0


def test_messages_list_omits_cube_text(auth):
    """消息列表不返回 cube 文本(单条约 0.9MB),避免打开会话时白等。"""
    sid = _chat("确认", auth).json()["session_id"]
    msgs = client.get(f"/api/sessions/{sid}/messages", headers=auth).json()
    assert [m["role"] for m in msgs] == ["user", "agent"]
    assert all("cube_text" not in m for m in msgs)


def test_generated_404_before_any_generation(auth):
    sid = client.post("/api/sessions", json={"title": "空会话"}, headers=auth).json()["id"]
    assert client.get(f"/api/sessions/{sid}/generated", headers=auth).status_code == 404


def test_generated_is_user_scoped(auth):
    """别人的会话取不到生成结果。"""
    sid = _chat("确认", auth).json()["session_id"]
    other = client.post("/api/auth/register", json={"username": "u2", "password": "secret123"}).json()
    other_headers = {"Authorization": f"Bearer {other['token']}"}
    assert client.get(f"/api/sessions/{sid}/generated", headers=other_headers).status_code == 404


def test_fake_llm_seam_runs_full_path(monkeypatch, auth):
    """CHROMA_FAKE_LLM=confirm 时应完全不触碰真实 LLM,并跑通生成+落库。

    这个桩给端到端验证用(浏览器测试、手工验证),必须保证它真的短路了 LLM。
    """
    monkeypatch.setenv("CHROMA_FAKE_LLM", "confirm")

    def _boom(*a, **kw):
        raise AssertionError("设置了 CHROMA_FAKE_LLM 却仍然调用了真实 LLM")

    monkeypatch.setattr("agent.llm.get_llm", _boom)
    monkeypatch.setattr("agent.llm.extract_result", _boom)

    body = client.post(
        "/api/session/chat",
        json={"message": "确认", "params": {"base_photo_style": "NAT", "temp": 1234}},
        headers=auth,
    ).json()
    assert body["done"] is True
    assert body["error"] is None
    assert "LUT_3D_SIZE 33" in body["cube_text"]

    gen = client.get(f"/api/sessions/{body['session_id']}/generated", headers=auth)
    assert gen.status_code == 200
    assert gen.json()["params"]["temp"] == 1234
    assert gen.json()["cube_text"] == body["cube_text"]
