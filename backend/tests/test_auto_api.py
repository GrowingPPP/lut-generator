"""自动修图 API 测试。

全部走 CHROMA_FAKE_GRADE 桩,不打真实 LLM、不消耗配额。
重点覆盖:base_params 必填(不许默认值兜底)、体积/格式校验、降级标记、落库。
"""
from api.auth import create_token
import json
import os

import pytest
from fastapi.testclient import TestClient

from api.main import app
from photo.fixtures import make_jpeg_bytes
from storage import db


@pytest.fixture(autouse=True)
def _clean():
    db.init_db()
    db.clear_all()
    db.clear_users()
    db.clear_sessions()
    os.environ["CHROMA_FAKE_GRADE"] = "1"      # 不调用真实 LLM
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

DEFAULT_PARAMS = {
    "base_photo_style": "STD", "temp": 0, "tint": 0, "exposure": 0, "contrast": 0,
    "saturation": 0, "hue": 0, "vibrance": 0, "tone_map": 1,
    "highlights": 0, "shadows": 0, "whites": 0, "blacks": 0, "curve": 0,
    "split_shadow_hue": 0, "split_shadow_sat": 0,
    "split_highlight_hue": 0, "split_highlight_sat": 0, "split_balance": 0.5,
    "lift": [0, 0, 0], "gamma": [1, 1, 1], "gain": [1, 1, 1],
}


def _post(auth, kind="under_exposed", params=None, **form):
    data = {"base_params": json.dumps(params if params is not None else DEFAULT_PARAMS)}
    data.update({k: str(v) for k, v in form.items()})
    return client.post(
        "/api/auto/grade",
        files={"file": ("photo.jpg", make_jpeg_bytes(kind), "image/jpeg")},
        data=data,
        headers=auth,
    )


# ---- 鉴权与基本可用 ----

def test_requires_auth():
    r = client.post("/api/auto/grade",
                    files={"file": ("p.jpg", make_jpeg_bytes(), "image/jpeg")},
                    data={"base_params": json.dumps(DEFAULT_PARAMS)})
    assert r.status_code == 401


def test_happy_path_returns_params(auth):
    r = _post(auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "params" in body
    assert isinstance(body["issues"], list)
    assert isinstance(body["degraded"], bool)
    # 参数必须齐全(能被 LutParamsModel 接受)
    assert set(body["params"]) >= {"base_photo_style", "temp", "exposure", "highlights", "split_balance"}
    assert body["before_params"] == DEFAULT_PARAMS
    assert isinstance(body["session_id"], int)


def test_persistence_failure_does_not_report_success(auth, monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("database unavailable")
    monkeypatch.setattr(db, "add_message", fail)
    r = _post(auth)
    assert r.status_code == 503
    assert "保存失败" in r.json()["detail"]


def test_detects_underexposure(auth):
    body = _post(auth, kind="under_exposed").json()
    codes = {i["code"] for i in body["issues"]}
    assert "under_exposed" in codes
    # 证据句必须是给人看的
    ev = next(i["evidence"] for i in body["issues"] if i["code"] == "under_exposed")
    assert "lum_p50" in ev and any(c.isdigit() for c in ev)


def test_clean_image_has_no_issues(auth):
    body = _post(auth, kind="neutral").json()
    assert body["issues"] == []


# ---- base_params 必填(增量语义的关键保护) ----

def test_missing_base_params_is_422(auth):
    """缺 base_params 必须 422 —— 用默认值兜底会静默抹掉用户的手调。"""
    r = client.post("/api/auto/grade",
                    files={"file": ("p.jpg", make_jpeg_bytes(), "image/jpeg")},
                    headers=auth)
    assert r.status_code == 422


def test_invalid_base_params_json_is_422(auth):
    r = client.post("/api/auto/grade",
                    files={"file": ("p.jpg", make_jpeg_bytes(), "image/jpeg")},
                    data={"base_params": "not json"}, headers=auth)
    assert r.status_code == 422


def test_out_of_range_base_params_is_422(auth):
    bad = dict(DEFAULT_PARAMS, exposure=99)
    r = _post(auth, params=bad)
    assert r.status_code == 422


def test_base_params_are_preserved_in_output(auth):
    """增量语义:用户手调必须原样保留在产出里。"""
    params = dict(DEFAULT_PARAMS, temp=520, saturation=-0.2)
    body = _post(auth, kind="neutral", params=params).json()
    assert body["params"]["temp"] == 520
    assert body["params"]["saturation"] == pytest.approx(-0.2)


# ---- 图片校验 ----

def test_undecodable_image_is_400(auth):
    r = client.post("/api/auto/grade",
                    files={"file": ("p.jpg", b"definitely not an image", "image/jpeg")},
                    data={"base_params": json.dumps(DEFAULT_PARAMS)}, headers=auth)
    assert r.status_code == 400
    assert "格式" in r.json()["detail"] or "解码" in r.json()["detail"]


def test_oversized_payload_is_413(auth, monkeypatch):
    import api.main as m
    monkeypatch.setattr(m, "MAX_AUTO_IMAGE_BYTES", 100)
    r = _post(auth)
    assert r.status_code == 413


def test_content_type_is_ignored_over_actual_content(auth):
    """校验实际内容而不是声明的 MIME —— 声明成 text/plain 的 JPEG 也该被接受。"""
    r = client.post("/api/auto/grade",
                    files={"file": ("p.txt", make_jpeg_bytes("neutral"), "text/plain")},
                    data={"base_params": json.dumps(DEFAULT_PARAMS)}, headers=auth)
    assert r.status_code == 200


# ---- 风格与视觉复核 ----

def test_style_is_optional(auth):
    assert _post(auth, style="").status_code == 200
    assert _post(auth).json()["style_params"] is None


def test_vision_flag_accepted(auth):
    r = _post(auth, use_vision=False)
    assert r.status_code == 200
    assert r.json()["review"] is None       # 桩模式下不调用 LLM,自然无复检


def test_max_rounds_is_clamped(auth):
    """max_rounds 越界不应报错,而是被夹到 1..3。"""
    assert _post(auth, max_rounds=99).status_code == 200
    assert _post(auth, max_rounds=0).status_code == 200


def test_diagnosis_steps_are_reported(auth):
    body = _post(auth, kind="under_exposed").json()
    assert body["steps"], "应有至少一步记录"
    for st in body["steps"]:
        assert st["stage"] in ("optimize", "style")
        assert isinstance(st["rejections"], list)


# ---- 降级标记 ----

def test_degraded_is_reported_honestly(auth):
    """高光严重溢出的图无法收敛 → 必须如实标记 degraded。"""
    body = _post(auth, kind="highlight_clip").json()
    assert body["degraded"] is True


def test_converged_case_not_degraded(auth):
    """能完全收敛的缺陷不能标 degraded(否则警示条会一直亮着)。

    实测:保守解能完全修好 low_contrast 这类「只需曝光/白平衡」的问题;
    而 under_exposed 因为保守解限幅 ±0.6EV 常常修不到目标区间,标 degraded 是诚实的。
    """
    body = _post(auth, kind="low_contrast").json()
    assert body["degraded"] is False


def test_underexposed_marked_degraded_honestly(auth):
    """欠曝超出保守解能力时,必须如实标记而不是假装成功。"""
    body = _post(auth, kind="under_exposed").json()
    assert body["degraded"] is True
    assert body["params"]["exposure"] <= 0.6 + 1e-6


# ---- 落库与隐私 ----

def test_result_is_persisted_as_message(auth):
    body = _post(auth, kind="under_exposed").json()
    user = db.get_user_by_username("u1")
    sessions = db.list_sessions(user["id"])
    assert sessions, "应创建一个会话用于留存自动修图结果"
    msgs = db.list_messages(sessions[0]["id"], user["id"])
    assert msgs, "应有留存消息"
    assert "自动修图" in msgs[-1]["content"]
    assert msgs[-1]["params_json"]


def test_image_bytes_are_never_persisted(auth):
    """隐私断言:任何表里都不该出现上传的图片二进制/base64。"""
    _post(auth, kind="under_exposed")
    user = db.get_user_by_username("u1")
    for s in db.list_sessions(user["id"]):
        for m in db.list_messages(s["id"], user["id"]):
            blob = (m["content"] or "") + (m["params_json"] or "")
            assert "data:image" not in blob
            assert "/9j/" not in blob, "消息里出现了 JPEG base64 前缀"


def test_cube_text_is_not_persisted(auth):
    """自动修图不写 cube_text —— 生成 LUT 应由用户按需触发,避免又一次 0.9MB 落库。"""
    _post(auth, kind="under_exposed")
    user = db.get_user_by_username("u1")
    rec = db.get_latest_generated_message(db.list_sessions(user["id"])[0]["id"], user["id"])
    assert rec is None


def test_persistence_failure_does_not_break_response(auth, monkeypatch):
    """落库失败不能影响主流程。"""
    import api.main as m
    monkeypatch.setattr(m.db, "create_session", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down")))
    r = _post(auth, kind="under_exposed")
    assert r.status_code == 200


def test_style_fields_distinguish_proposal_from_result(auth):
    """API 层必须把「风格提议」与「风格实际应用」分开暴露。

    回归一个真 bug:风格被硬校验拦下时,响应里仍有 style_params,
    前端据此渲染出「风格理解:曝光 -0.30 EV」,而曝光滑杆没动 ——
    用户合理地以为「调整没作用到参数上」。
    """
    body = _post(auth, kind="warm_cast", style="极暖").json()
    assert "style_applied" in body
    assert "style_applied_params" in body
    assert "style_rejections" in body
    if body["style_applied"] is False and body["style_params"]:
        # 关键断言:未应用时不能给出「已应用」的参数
        assert body["style_applied_params"] is None, \
            "被拒的风格不该带 style_applied_params"
        assert body["style_rejections"], "被拒应给出原因"


def test_applied_style_params_match_final_params(auth):
    """凡是标为已应用的字段,最终 params 里必须一致。"""
    body = _post(auth, kind="neutral", style="稍微提亮一点").json()
    if body["style_applied"] and body["style_applied_params"]:
        for k, v in body["style_applied_params"].items():
            assert body["params"][k] == pytest.approx(v, abs=1e-6), \
                f"{k} 标为已应用但最终参数不符"
