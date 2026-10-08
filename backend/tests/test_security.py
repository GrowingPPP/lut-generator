"""安全与健壮性回归:下载头净化、限流有界性与窗口、JWT 密钥校验。"""
import time

import pytest
from fastapi.testclient import TestClient

from api import auth, ratelimit
from storage import db
from api.main import app, _content_disposition, _safe_stem


@pytest.fixture(autouse=True)
def _clean():
    db.init_db()
    db.clear_all()
    db.clear_users()
    yield
    db.clear_all()
    db.clear_users()


@pytest.fixture()
def auth_headers():
    r = client.post("/api/auth/register", json={"username": "u1", "password": "secret123"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


client = TestClient(app)


# ---- 下载文件名净化 ----

@pytest.mark.parametrize(
    "raw,expect_absent",
    [
        ("evil\r\nX-Injected: 1", "\r"),
        ("evil\r\nX-Injected: 1", "\n"),
        ("a/b", "/"),
        ("a\\b", "\\"),
        ("tab\there", "\t"),
    ],
)
def test_safe_stem_strips_dangerous_chars(raw, expect_absent):
    assert expect_absent not in _safe_stem(raw)


def test_safe_stem_fallback_on_empty():
    assert _safe_stem("") == "lut"
    assert _safe_stem("   ") == "lut"


def test_content_disposition_no_header_break():
    """无论如何都不能在头值里出现 CR/LF,否则等于响应头注入。"""
    header = _content_disposition(_safe_stem("evil\r\nX-Injected: 1"), "camera")
    assert "\r" not in header and "\n" not in header
    assert header.startswith("attachment; ")
    assert "filename*=UTF-8''" in header


def test_content_disposition_ascii_fallback_not_broken_by_quote():
    """filename= 是带引号的参数,里面不能再出现裸引号或反斜杠。"""
    header = _content_disposition(_safe_stem('a"b\\c"'), "camera")
    quoted = header.split('filename="', 1)[1].split('"', 1)[0]
    assert '"' not in quoted and "\\" not in quoted
    assert quoted.isascii()


def test_download_header_and_mode_validation(auth_headers):
    lid = client.post(
        "/api/luts", json={"name": "日系/清透", "description": "", "params": {}}, headers=auth_headers
    ).json()["id"]

    r = client.get(f"/api/luts/{lid}/download?mode=camera", headers=auth_headers)
    assert r.status_code == 200
    cd = r.headers["content-disposition"]
    assert "\r" not in cd and "\n" not in cd
    assert "%2F" not in cd  # 路径分隔符已在主干阶段剔除
    assert r.text.startswith("TITLE")

    # mode 只接受 camera/software,其他值直接被框架拒掉
    assert client.get(f"/api/luts/{lid}/download?mode=evil", headers=auth_headers).status_code == 422


def test_download_software_mode_has_no_camera_header(auth_headers):
    lid = client.post(
        "/api/luts", json={"name": "x", "description": "", "params": {}}, headers=auth_headers
    ).json()["id"]
    cam = client.get(f"/api/luts/{lid}/download?mode=camera", headers=auth_headers).text
    soft = client.get(f"/api/luts/{lid}/download?mode=software", headers=auth_headers).text
    assert "#LUMIXPHOTOSTYLE" in cam
    assert "#LUMIXPHOTOSTYLE" not in soft


# ---- 限流 ----

def test_ratelimit_blocks_after_max_failures():
    ip = "203.0.113.9"
    ratelimit.reset(ip)
    for _ in range(ratelimit._MAX_FAILURES):
        assert ratelimit.is_blocked(ip) is False
        ratelimit.record_failure(ip)
    assert ratelimit.is_blocked(ip) is True
    ratelimit.reset(ip)
    assert ratelimit.is_blocked(ip) is False


def test_ratelimit_window_expires(monkeypatch):
    ip = "203.0.113.10"
    ratelimit.reset(ip)
    for _ in range(ratelimit._MAX_FAILURES):
        ratelimit.record_failure(ip)
    assert ratelimit.is_blocked(ip) is True
    # 把窗口拨到过去,旧记录应被剪掉
    monkeypatch.setattr(ratelimit, "_WINDOW_SECONDS", 0)
    assert ratelimit.is_blocked(ip) is False
    ratelimit.reset(ip)


def test_ratelimit_reset_does_not_leak_entries():
    ip = "203.0.113.11"
    ratelimit.record_failure(ip)
    ratelimit.reset(ip)
    assert ip not in ratelimit._failures


def test_ratelimit_tracked_ips_is_bounded(monkeypatch):
    """大量来源 IP 不能把内存撑爆。"""
    monkeypatch.setattr(ratelimit, "_MAX_TRACKED_IPS", 50)
    ratelimit._failures.clear()
    for i in range(500):
        ratelimit.record_failure(f"198.51.100.{i}")
    assert len(ratelimit._failures) <= 50
    ratelimit._failures.clear()


def test_ratelimit_state_survives_prune_of_other_ips():
    """剪枝只影响过期 IP,不能把仍在窗口内的计数清掉。"""
    hot, cold = "203.0.113.12", "203.0.113.13"
    ratelimit.reset(hot)
    ratelimit.reset(cold)
    for _ in range(3):
        ratelimit.record_failure(hot)
    assert ratelimit.is_blocked(hot) is False
    assert len(ratelimit._failures[hot]) == 3
    ratelimit.reset(hot)
    ratelimit.reset(cold)


# ---- JWT 密钥 ----

def test_validate_secret_rejects_placeholder():
    with pytest.raises(RuntimeError, match="占位值"):
        auth._validate_secret("change-me-to-a-long-random-string")


def test_validate_secret_rejects_short():
    with pytest.raises(RuntimeError, match="太短"):
        auth._validate_secret("short")


def test_validate_secret_accepts_long_random():
    good = "k" * 32
    assert auth._validate_secret(good) == good


def test_production_requires_explicit_secret(monkeypatch):
    monkeypatch.delenv("CHROMA_JWT_SECRET", raising=False)
    monkeypatch.setenv("CHROMA_ENV", "production")
    with pytest.raises(RuntimeError, match="必须显式配置"):
        auth._resolve_secret()


def test_dev_fallback_secret_is_stable(monkeypatch):
    """兜底密钥落盘复用:反复解析结果一致,否则重启即掉登录态。"""
    monkeypatch.delenv("CHROMA_JWT_SECRET", raising=False)
    monkeypatch.delenv("CHROMA_ENV", raising=False)
    with pytest.warns(UserWarning):
        first = auth._resolve_secret()
    second = auth._load_dev_secret()
    assert first == second
    assert len(first) >= auth._MIN_SECRET_LEN
