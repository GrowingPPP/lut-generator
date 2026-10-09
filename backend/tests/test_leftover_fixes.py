"""遗留问题修复的回归测试(阶段 A-D)。

对应 docs/leftover-issues.md:
  A  会话复用 + 结构化 payload + 报告查询端点
  B  按用户的自动修图限流
  C  上游错误分类映射
  D  上传检查分段(字节 413 / 像素 413)
"""
from api.auth import create_token
import json
from concurrent.futures import ThreadPoolExecutor
import os

import pytest
from fastapi.testclient import TestClient
from openai import APIConnectionError, APIStatusError, APITimeoutError

from api import ratelimit
from api.main import LutParamsModel, app
from photo.fixtures import make_jpeg_bytes
from storage import db


@pytest.fixture(autouse=True)
def _clean():
    db.init_db()
    db.clear_all()
    db.clear_users()
    db.clear_sessions()
    os.environ["CHROMA_FAKE_GRADE"] = "1"
    yield
    db.clear_all()
    db.clear_users()
    db.clear_sessions()
    os.environ.pop("CHROMA_FAKE_GRADE", None)


@pytest.fixture()
def auth():
    r = client.post("/api/auth/register", json={"username": "u1", "password": "secret123"})
    return {"Authorization": f"Bearer {create_token(r.json()['user_id'], 0)}"}


client = TestClient(app)
PARAMS = LutParamsModel().model_dump()


def _grade(auth, kind="neutral", **form):
    data = {"base_params": json.dumps(PARAMS)}
    data.update({k: str(v) for k, v in form.items()})
    return client.post("/api/auto/grade",
                       files={"file": ("p.jpg", make_jpeg_bytes(kind), "image/jpeg")},
                       data=data, headers=auth)


# ---------------- A. 会话复用 ----------------

def test_repeated_grades_share_one_session(auth):
    """反复自动修图只应有**一个**会话 —— 否则会把用户的创作会话挤出列表。"""
    for _ in range(5):
        assert _grade(auth).status_code == 200
    sessions = db.list_sessions(db.get_user_by_username("u1")["id"])
    assert len(sessions) == 1, f"应复用单一会话,实际 {len(sessions)} 个:{[s['title'] for s in sessions]}"
    assert sessions[0]["title"] == "自动修图"


def test_auto_session_is_flagged_not_title_matched(auth):
    """用显式 is_auto 标记判会话,不靠标题字符串 —— 用户改标题不该影响复用。"""
    _grade(auth)
    user = db.get_user_by_username("u1")
    sid = db.list_sessions(user["id"])[0]["id"]
    # 用户把标题改掉
    db.update_session(sid, user["id"], "我改的名字")
    _grade(auth)
    sessions = db.list_sessions(user["id"])
    assert len(sessions) == 1, "改标题后不应新建会话"
    assert sessions[0]["title"] == "我改的名字"


def test_each_grade_appends_a_message(auth):
    for _ in range(3):
        _grade(auth)
    user = db.get_user_by_username("u1")
    sid = db.list_sessions(user["id"])[0]["id"]
    assert len(db.list_messages(sid, user["id"])) == 3


def test_report_endpoint_restores_latest(auth):
    """刷新后重建报告的数据来源。"""
    body = _grade(auth, kind="under_exposed").json()
    rep = client.get("/api/auto/report", headers=auth)
    assert rep.status_code == 200
    got = rep.json()
    assert got is not None
    assert got["params"] == body["params"]
    assert [i["code"] for i in got["issues"]] == [i["code"] for i in body["issues"]]
    assert len(got["steps"]) == len(body["steps"])


def test_report_carries_own_session_id(auth):
    """响应必须带 session_id —— 前端据此判断该不该在当前会话展示,
    否则在任何会话里都会弹出上一份报告。"""
    _grade(auth)
    user = db.get_user_by_username("u1")
    sid = db.list_sessions(user["id"])[0]["id"]
    got = client.get("/api/auto/report", headers=auth).json()
    assert got["session_id"] == sid


def test_report_endpoint_returns_null_for_new_user(auth):
    """还没修过图是正常状态,不是 404。"""
    r = client.get("/api/auto/report", headers=auth)
    assert r.status_code == 200
    assert r.json() is None
    assert not db.list_sessions(db.get_user_by_username("u1")["id"])


def test_report_can_be_undone_after_reload(auth):
    body = _grade(auth).json()
    report = client.get("/api/auto/report", headers=auth).json()
    assert report["before_params"] == body["before_params"]
    assert report["session_id"] == body["session_id"]
    undone = client.post("/api/auto/undo", headers=auth)
    assert undone.status_code == 200
    assert undone.json()["params"] == body["before_params"]
    assert client.get("/api/auto/report", headers=auth).json() is None
    assert client.post("/api/auto/undo", headers=auth).status_code == 404


def test_report_endpoint_requires_auth():
    assert client.get("/api/auto/report").status_code == 401


def test_report_is_user_scoped(auth):
    """别人的报告取不到。"""
    _grade(auth)
    other = client.post("/api/auth/register",
                        json={"username": "u2", "password": "secret123"}).json()
    h2 = {"Authorization": f"Bearer {create_token(other['user_id'], 0)}"}
    assert client.get("/api/auto/report", headers=h2).json() is None


def test_report_survives_corrupt_payload(auth):
    """历史数据格式不符时当作没有,而不是 500。"""
    _grade(auth)
    user = db.get_user_by_username("u1")
    sid = db.list_sessions(user["id"])[0]["id"]
    db.add_message(user["id"], sid, "agent", "坏数据", None, None, "{不是合法 JSON")
    r = client.get("/api/auto/report", headers=auth)
    assert r.status_code == 200
    assert r.json() is None


# ---------------- B. 限流 ----------------

def test_quota_blocks_after_limit(auth, monkeypatch):
    monkeypatch.setattr(ratelimit, "AUTO_MAX_PER_WINDOW", 3)
    user = db.get_user_by_username("u1")
    codes = [_grade(auth).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3:] == [429, 429]


def test_quota_reservation_is_atomic_across_connections(auth):
    user_id = db.get_user_by_username("u1")["id"]
    with ThreadPoolExecutor(max_workers=6) as pool:
        retries = list(pool.map(lambda _: db.reserve_auto_grade_call(user_id, 2, 3600), range(6)))
    assert retries.count(0) == 2
    assert all(r > 0 for r in retries if r != 0)


def test_quota_returns_retry_after(auth, monkeypatch):
    monkeypatch.setattr(ratelimit, "AUTO_MAX_PER_WINDOW", 1)
    user = db.get_user_by_username("u1")
    _grade(auth)
    r = _grade(auth)
    assert r.status_code == 429
    assert r.headers.get("retry-after")
    assert int(r.headers["retry-after"]) > 0
    assert "分钟" in r.json()["detail"] or "上限" in r.json()["detail"]


def test_quota_is_per_user_not_per_ip(auth, monkeypatch):
    """按 user 计数:登录用户换 IP 不该成为绕过手段。"""
    monkeypatch.setattr(ratelimit, "AUTO_MAX_PER_WINDOW", 1)
    u1 = db.get_user_by_username("u1")
    assert _grade(auth).status_code == 200
    assert _grade(auth).status_code == 429

    other = client.post("/api/auth/register",
                        json={"username": "u2", "password": "secret123"}).json()
    u2 = db.get_user_by_username("u2")
    h2 = {"Authorization": f"Bearer {create_token(other['user_id'], 0)}"}
    assert _grade(h2).status_code == 200, "另一个用户不应受 u1 的配额影响"


def test_rejected_request_does_not_consume_quota(auth, monkeypatch):
    """校验失败的请求不该占用配额 —— 否则用户传错图也会被扣次数。"""
    monkeypatch.setattr(ratelimit, "AUTO_MAX_PER_WINDOW", 2)
    user = db.get_user_by_username("u1")
    bad = client.post("/api/auto/grade",
                      files={"file": ("p.jpg", b"not an image", "image/jpeg")},
                      data={"base_params": json.dumps(PARAMS)}, headers=auth)
    assert bad.status_code == 400
    assert _grade(auth).status_code == 200
    assert _grade(auth).status_code == 200


# ---------------- C. 错误映射 ----------------

def _raise_from_grade(monkeypatch, exc):
    """让编排抛指定异常。

    端点内部是 `from agent.auto import auto_grade`,每次调用时重新取模块属性,
    所以 patch `agent.auto.auto_grade` 才能生效 —— patch api.main 上的名字没用
    (它根本没有这个名字)。
    """
    import agent.auto as a

    def _boom(*_a, **_kw):
        raise exc
    monkeypatch.setattr(a, "auto_grade", _boom)


def _fake_status_error(status=500):
    import httpx
    req = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
    return APIStatusError("boom", response=httpx.Response(status, request=req), body=None)


def test_timeout_maps_to_504(auth, monkeypatch):
    import httpx
    _raise_from_grade(monkeypatch, APITimeoutError(request=httpx.Request("POST", "https://x")))
    r = _grade(auth)
    assert r.status_code == 504
    assert "超时" in r.json()["detail"]


def test_connection_error_maps_to_504(auth, monkeypatch):
    import httpx
    _raise_from_grade(monkeypatch, APIConnectionError(request=httpx.Request("POST", "https://x")))
    assert _grade(auth).status_code == 504


def test_upstream_status_error_maps_to_502_with_code(auth, monkeypatch):
    _raise_from_grade(monkeypatch, _fake_status_error(503))
    r = _grade(auth)
    assert r.status_code == 502
    assert "503" in r.json()["detail"], f"应保留上游状态码便于排查:{r.json()['detail']}"


def test_budget_exhausted_gives_actionable_hint(auth, monkeypatch):
    """预算耗尽不是「服务挂了」,要给可操作提示。"""
    from agent.llm import BudgetExhaustedError
    _raise_from_grade(monkeypatch, BudgetExhaustedError("预算不足"))
    r = _grade(auth)
    assert r.status_code == 502
    assert "MAX_TOKENS" in r.json()["detail"], f"应给出可操作提示:{r.json()['detail']}"


def test_unexpected_error_stays_generic(auth, monkeypatch):
    """未预期异常不泄露内部细节。"""
    _raise_from_grade(monkeypatch, RuntimeError("内部细节 abc"))
    r = _grade(auth)
    assert r.status_code == 502
    assert "abc" not in r.json()["detail"]
    assert "暂时不可用" in r.json()["detail"]


# ---------------- D. 上传检查 ----------------

def test_byte_limit_honours_content_length(auth, monkeypatch):
    """先看 Content-Length 预判,省掉把大文件读进内存再拒绝。"""
    import api.main as m
    monkeypatch.setattr(m, "MAX_AUTO_IMAGE_BYTES", 100)
    r = _grade(auth)
    assert r.status_code == 413


def test_pixel_limit_is_413_not_400(auth, monkeypatch):
    """像素数超限也是「太大」,应是 413 而非 400。"""
    import io
    from PIL import Image
    import api.main as m
    monkeypatch.setattr(m, "MAX_AUTO_IMAGE_BYTES", 64 * 1024 * 1024)
    img = Image.new("RGB", (400, 400), (10, 10, 10))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    # 把像素上限压到很小,触发 ImageTooLargeError
    import photo.stats as ps
    monkeypatch.setattr(ps, "MAX_PIXELS", 1000)
    r = client.post("/api/auto/grade",
                    files={"file": ("p.png", buf.getvalue(), "image/png")},
                    data={"base_params": json.dumps(PARAMS)}, headers=auth)
    assert r.status_code == 413, f"像素超限应为 413,实际 {r.status_code}:{r.text[:200]}"
