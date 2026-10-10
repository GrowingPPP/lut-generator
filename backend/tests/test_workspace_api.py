"""工作区归属、不可变快照、配方和逐图测量的 HTTP 契约。"""
import io
import json
from uuid import uuid4

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from api.auth import create_token
from api.main import app, LutParamsModel
from lut_engine.recipe import apply_recipe, input_contract, RecipeError, validate_recipe
from storage import db

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean():
    db.clear_all()
    db.clear_sessions()
    db.clear_users()
    yield
    db.clear_all()
    db.clear_sessions()
    db.clear_users()


@pytest.fixture()
def headers():
    user_id = db.create_user("workspace-user","unused-hash")
    return {"Authorization":f"Bearer {create_token(user_id,0)}"}


def workspace(headers,**body):
    response = client.post("/api/workspaces",json=body,headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def recipe(**operations):
    return {"format_version":1,"kind":"portable_style","input_contract":input_contract({}),
            "operations":{"contrast":{"mode":"add","value":.1},
                          "contrast_pivot":{"mode":"set","value":.462,"dependency":True},
                          "look_strength":{"mode":"set","value":1.,"dependency":True},**operations},
            "source":{"transaction_ids":[str(uuid4())]}}


def png():
    image = np.zeros((48,64,3),np.uint8)
    image[:,:32] = [65,78,91]
    image[:,32:] = [135,110,97]
    buff = io.BytesIO()
    Image.fromarray(image).save(buff,format="PNG")
    return buff.getvalue()


def test_workspace_uuid_idempotent_and_user_isolation(headers):
    wid = str(uuid4())
    first = workspace(headers,id=wid,name="场景一")
    second = workspace(headers,id=wid,name="另一名称")
    assert first == second
    other_id = db.create_user("other-workspace-user","unused-hash")
    other = {"Authorization":f"Bearer {create_token(other_id,0)}"}
    assert client.post("/api/workspaces",json={"id":wid},headers=other).status_code == 409
    assert client.get(f"/api/workspaces/{wid}",headers=other).status_code == 404
    assert client.get("/api/workspaces",headers=other).json() == []


def test_workspace_rejects_another_users_session(headers):
    other_id = db.create_user("other-session-owner","unused-hash")
    sid = db.create_session(other_id,"private")
    assert client.post("/api/workspaces",json={"session_id":sid},headers=headers).status_code == 404


def test_version_immutable_snapshot_and_projection(headers):
    wid = workspace(headers)["id"]
    source = {"workspace_snapshot":{"baseline":{"params":{"exposure":.3}},
                                     "recipe_projection":{"contributions":[]},"input_status":"confirmed"}}
    original = client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={
        "name":"最初","params":{"exposure":.3},"source":source,
        "context":{"goal_mode":"preserve","locked_fields":["exposure"]}})
    assert original.status_code == 200, original.text
    data = original.json()
    renamed = client.patch(f"/api/workspaces/{wid}/versions/{data['id']}",headers=headers,json={"name":"改名"}).json()
    assert renamed["params"] == data["params"]
    assert renamed["source"] == source
    assert renamed["context"] == data["context"]
    assert client.patch(f"/api/workspaces/{wid}/versions/{data['id']}",headers=headers,
                        json={"name":"非法","params":{"exposure":1}}).status_code == 422


def test_versions_limit_twenty_and_delete(headers):
    wid = workspace(headers)["id"]
    ids = []
    for i in range(20):
        response = client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={"name":str(i),"params":{}})
        assert response.status_code == 200
        ids.append(response.json()["id"])
    assert client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={"name":"21","params":{}}).status_code == 409
    assert client.delete(f"/api/workspaces/{wid}/versions/{ids[0]}",headers=headers).status_code == 204
    assert client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={"name":"new","params":{}}).status_code == 200


def test_restore_atomic_input_and_lock_conflict(headers):
    wid = workspace(headers)["id"]
    version = client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={
        "name":"视频","params":{"base_photo_style":"VLOG","exposure":.5},
        "context":{"goal_mode":"style_only","locked_fields":["temp"]}}).json()
    route = f"/api/workspaces/{wid}/versions/{version['id']}/restore"
    body = {"params":{},"context":{"goal_mode":"preserve","locked_fields":["exposure","gain"]}}
    response = client.post(route,headers=headers,json=body)
    assert response.status_code == 409
    assert response.json()["detail"]["locked_fields"] == ["exposure"]
    body.update(unlock_conflicts=True,allow_input_change=True)
    restored = client.post(route,headers=headers,json=body).json()
    assert restored["params"] == version["params"]
    assert restored["context"] == {"goal_mode":"style_only","locked_fields":["gain"]}
    assert client.get(f"/api/workspaces/{wid}/versions/{version['id']}",headers=headers).json()["context"]["locked_fields"] == ["temp"]


def test_session_delete_detaches_and_optionally_deletes_versions(headers):
    sid = client.post("/api/sessions",headers=headers,json={"title":"workspace"}).json()["id"]
    wid = workspace(headers,session_id=sid)["id"]
    client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={"name":"keep","params":{}})
    assert client.delete(f"/api/sessions/{sid}",headers=headers).status_code == 204
    assert client.get(f"/api/workspaces/{wid}",headers=headers).json()["session_id"] is None
    assert len(client.get(f"/api/workspaces/{wid}/versions",headers=headers).json()) == 1
    sid = client.post("/api/sessions",headers=headers,json={"title":"again"}).json()["id"]
    client.patch(f"/api/workspaces/{wid}",headers=headers,json={"session_id":sid})
    client.delete(f"/api/sessions/{sid}?delete_workspace_versions=true",headers=headers)
    assert client.get(f"/api/workspaces/{wid}/versions",headers=headers).json() == []


def test_portable_style_saves_neutral_and_revision_is_immutable(headers):
    created = client.post("/api/luts",headers=headers,json={"name":"配方","kind":"portable_style",
        "params":{"exposure":1},"recipe":recipe()})
    assert created.status_code == 200,created.text
    asset = created.json()
    assert asset["params"]["exposure"] == 0
    assert asset["params"]["contrast"] == .1
    first_revision = asset["revision_id"]
    updated = client.put(f"/api/luts/{asset['id']}",headers=headers,json={
        "name":"配方2","recipe":recipe(contrast={"mode":"add","value":.2})}).json()
    assert updated["revision_id"] != first_revision
    old = client.post(f"/api/luts/{asset['id']}/apply",headers=headers,json={"params":{},"revision_id":first_revision}).json()
    assert old["params"]["contrast"] == .1
    assert len(client.get(f"/api/luts/{asset['id']}/revisions",headers=headers).json()) == 2


def test_apply_repeat_locks_input_and_overflow_are_atomic(headers):
    asset = client.post("/api/luts",headers=headers,json={"name":"style","kind":"portable_style","recipe":recipe()}).json()
    route = f"/api/luts/{asset['id']}/apply"
    for body,code in [({"params":{},"applied_revision_ids":[asset["revision_id"]]},"repeat_application"),
                      ({"params":{},"context":{"locked_fields":["contrast"]}},"lock_conflict"),
                      ({"params":{"base_photo_style":"NAT"}},"input_conflict"),
                      ({"params":{"contrast":.95}},"out_of_range")]:
        response = client.post(route,headers=headers,json=body)
        assert response.status_code in (409,422),response.text
        assert response.json()["detail"]["code"] == code
    good = client.post(route,headers=headers,json={"params":{"exposure":.3},"allow_repeat":True,
                                              "applied_revision_ids":[asset["revision_id"]]}).json()
    assert good["params"]["exposure"] == .3
    assert good["params"]["contrast"] == .1
    assert client.get(f"/api/luts/{asset['id']}",headers=headers).json()["params"]["exposure"] == 0


def test_portable_download_requires_target_and_current_is_not_applied_twice(headers):
    asset = client.post("/api/luts",headers=headers,json={"name":"style","kind":"portable_style","recipe":recipe()}).json()
    route = f"/api/luts/{asset['id']}/download"
    assert client.get(route,headers=headers).status_code == 422
    assert client.get(route+"?target=neutral&mode=software",headers=headers).status_code == 200
    actual = client.post(route,headers=headers,json={"mode":"software","target":"current","params":{"contrast":.1}})
    saved = client.get(route+"?target=neutral&mode=software",headers=headers)
    assert actual.status_code == 200 and actual.content == saved.content


@pytest.mark.parametrize("bad", [
    {"contrast":{"mode":"add","value":".1"}},
    {"contrast":{"mode":"add","value":True}},
    {"sharpen":{"mode":"add","value":.1}},
    {"tone_map":{"mode":"set","value":.5}},
    {"lift":{"mode":"add","value":[0,0]}},
    {"contrast_pivot":{"mode":"add","value":.1,"dependency":True}},
])
def test_recipe_rejects_invalid_operations(headers,bad):
    response = client.post("/api/luts",headers=headers,json={"name":"bad","kind":"portable_style","recipe":recipe(**bad)})
    assert response.status_code == 422,response.text


def test_recipe_rejects_missing_dependencies_nonfinite_and_validates_rgb_delta():
    missing = recipe()
    del missing["operations"]["contrast_pivot"]
    with pytest.raises(RecipeError,match="依赖"):
        validate_recipe(missing)
    with pytest.raises(RecipeError,match="有限"):
        validate_recipe(recipe(temp={"mode":"add","value":float("nan")}))
    valid = recipe(gamma={"mode":"add","value":[-.1,0,.1]})
    candidate,_ = apply_recipe(valid,{"gamma":[1,1,1]})
    assert candidate["gamma"] == [.9,1,1.1]
    with pytest.raises(RecipeError,match="范围"):
        apply_recipe(valid,{"gamma":[.5,1,1.5]})


def test_multisample_partial_failure_actual_digest_dimensions_and_persistence(headers):
    wid = workspace(headers)["id"]
    samples = [{"id":"good","input_contract":input_contract({}),"source_digest":"original-digest","origin":"restored_preview"},
               {"id":"bad","input_contract":input_contract({})}]
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":"{}","samples":json.dumps(samples)},
        files=[("files",("preview.png",png(),"image/png")),("files",("bad.png",b"bad","image/png"))])
    assert response.status_code == 200,response.text
    result = response.json()
    good,bad = result["results"]
    assert good["status"] == "no_new_risk" and bad["status"] == "unmeasurable"
    assert good["origin"] == "restored_preview" and good["source_digest"] == "original-digest"
    assert good["measurement_dimensions"] == {"width":64,"height":48}
    assert good["sampled_pixels"] == 64*48
    assert len(good["measured_pixel_digest"]) == 64
    stored = client.get(f"/api/workspaces/{wid}/validation",headers=headers).json()
    assert stored == result
    record = db.latest_workspace_report(wid,db.get_user_by_username("workspace-user")["id"],"validation")
    assert "data:image" not in record["payload_json"] and len(record["payload_json"]) < 10000


def test_vlog_validation_baseline_keeps_display_mapping(headers):
    wid = workspace(headers)["id"]
    params = {"base_photo_style":"VLOG","tone_map":.7}
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":json.dumps(params),"samples":json.dumps([{"id":"vlog","input_contract":input_contract(params)}])},
        files={"files":("v.png",png(),"image/png")})
    assert response.status_code == 200,response.text
    measured = response.json()["results"][0]
    assert measured["baseline"] == measured["current"]
    assert measured["baseline_pixel_digest"] != measured["measured_pixel_digest"]


def test_multisample_limit_and_input_failure(headers):
    wid = workspace(headers)["id"]
    refs = [{"id":str(i),"input_contract":input_contract({})} for i in range(6)]
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":"{}","samples":json.dumps(refs)},files=[("files",("p.png",png(),"image/png"))]*6)
    assert response.status_code == 422
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":"{}","samples":json.dumps([{"id":"wrong","input_contract":input_contract({"base_photo_style":"NAT"})}])},
        files={"files":("p.png",png(),"image/png")})
    assert response.status_code == 200 and response.json()["results"][0]["status"] == "unmeasurable"


def test_auto_workspace_report_bound_and_new_session_not_fixed(headers,monkeypatch):
    monkeypatch.setenv("CHROMA_FAKE_GRADE","1")
    wid = workspace(headers)["id"]
    response = client.post("/api/auto/grade",headers=headers,
        data={"base_params":"{}","workspace_id":wid,"context":json.dumps({"goal_mode":"preserve","locked_fields":["exposure"]}),
              "source_digest":"source-123","main_sample_id":"main-1","use_vision":"false"},
        files={"file":("p.png",png(),"image/png")})
    assert response.status_code == 200,response.text
    out = response.json()
    user_id = db.get_user_by_username("workspace-user")["id"]
    assert db.get_session(out["session_id"],user_id)["is_auto"] == 0
    assert db.find_auto_session(user_id) is None
    assert out["workspace_id"] == wid and out["source_digest"] == "source-123"
    assert out["main_sample_id"] == "main-1" and out["execution_status"] == "skipped"
    for phase in out["steps"]:
        assert len(phase["params_before"]) == 34 and len(phase["params_after"]) == 34
    assert client.get(f"/api/auto/report?workspace_id={wid}",headers=headers).json() == out
    assert client.get("/api/auto/report",headers=headers).json() is None
    other = workspace(headers)["id"]
    assert client.get(f"/api/auto/report?workspace_id={other}",headers=headers).json() is None


def test_chat_receives_complete_context_and_returns_actual_phases(headers,monkeypatch):
    from agent import graph
    captured = {}
    def run(extract,message,params=None,**kwargs):
        captured.update(params=params,context=kwargs["context"].model_dump())
        after = {**params,"saturation":.2}
        return {"reply":"ok","params":after,"done":False,"execution_status":"model",
                "steps":[{"stage":"chat","params_before":params,"params_after":after,"purpose":"unclassified"}]}
    monkeypatch.setattr(graph,"run_agent",run)
    monkeypatch.setenv("CHROMA_FAKE_LLM","confirm")
    wid = workspace(headers)["id"]
    response = client.post("/api/session/chat",headers=headers,json={"message":"风格","params":{},"workspace_id":wid,
        "context":{"goal_mode":"preserve","locked_fields":["exposure"]},"source_digest":"src","main_sample_id":"main"})
    assert response.status_code == 200,response.text
    assert len(captured["params"]) == 34 and captured["context"]["locked_fields"] == ["exposure"]
    assert response.json()["steps"][0]["params_after"]["saturation"] == .2
    assert response.json()["workspace_id"] == wid


def test_metadata_rejects_image_and_nonfinite(headers):
    wid = workspace(headers)["id"]
    assert client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={
        "name":"bad","params":{},"source":{"picture":"data:image/png;base64,abc"}}).status_code == 422
    body = json.dumps({"name":"bad","params":{},"source":{"value":float("nan")}})
    assert client.post(f"/api/workspaces/{wid}/versions",headers={**headers,"Content-Type":"application/json"},content=body).status_code == 422


def test_sample_compatibility_ignores_current_display_mapping(headers):
    wid = workspace(headers)["id"]
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":json.dumps({"base_photo_style":"VLOG","tone_map":.5}),
              "samples":json.dumps([{"id":"vlog","input_contract":input_contract({"base_photo_style":"VLOG"})}])},
        files={"files":("p.png",png(),"image/png")})
    assert response.status_code == 200,response.text
    sample = response.json()["results"][0]
    assert sample["status"] == "no_new_risk"
    assert sample["input_contract"]["tone_map"] == 1
    assert sample["measured_input_contract"]["tone_map"] == .5
    assert sample["baseline"] == sample["current"]


def test_image_validated_recipe_apply_accepts_safe_and_rejects_clipping(headers):
    safe = client.post("/api/luts",headers=headers,json={"name":"safe","kind":"portable_style","recipe":recipe()}).json()
    response = client.post(f"/api/luts/{safe['id']}/apply-validated",headers=headers,
        data={"body":json.dumps({"params":{}})},files={"file":("p.png",png(),"image/png")})
    assert response.status_code == 200,response.text
    assert response.json()["validation_status"] == "measured"
    harsh = recipe(exposure={"mode":"add","value":3})
    asset = client.post("/api/luts",headers=headers,json={"name":"harsh","kind":"portable_style","recipe":harsh}).json()
    response = client.post(f"/api/luts/{asset['id']}/apply-validated",headers=headers,
        data={"body":json.dumps({"params":{}})},files={"file":("p.png",png(),"image/png")})
    assert response.status_code == 409,response.text
    assert response.json()["detail"]["code"] == "image_risk"


@pytest.mark.parametrize("value",[float("nan"),float("inf"),-float("inf")])
def test_nonfinite_numeric_http_is_422(headers,value):
    raw = json.dumps({"name":"bad","params":{"exposure":value}})
    response = client.post("/api/luts",headers={**headers,"Content-Type":"application/json"},content=raw)
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


def test_workspace_auto_report_survives_session_unlink(headers,monkeypatch):
    monkeypatch.setenv("CHROMA_FAKE_GRADE","1")
    wid = workspace(headers)["id"]
    out = client.post("/api/auto/grade",headers=headers,data={"base_params":"{}","workspace_id":wid},
                      files={"file":("p.png",png(),"image/png")}).json()
    client.delete(f"/api/sessions/{out['session_id']}",headers=headers)
    report = client.get(f"/api/auto/report?workspace_id={wid}",headers=headers)
    assert report.status_code == 200 and report.json()["session_id"] is None
    assert report.json()["params"] == out["params"]
    undone = client.post(f"/api/auto/undo?workspace_id={wid}",headers=headers)
    assert undone.status_code == 200
    assert client.get(f"/api/auto/report?workspace_id={wid}",headers=headers).json() is None


def test_batch_byte_limits_are_bounded_and_single_failure_is_partial(headers,monkeypatch):
    from api import workspaces as W
    wid = workspace(headers)["id"]
    refs = [{"id":"one","input_contract":input_contract({})},{"id":"two","input_contract":input_contract({})}]
    payload = png()
    monkeypatch.setattr(W,"MAX_IMAGE_BYTES",len(payload)-1)
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":"{}","samples":json.dumps(refs)},
        files=[("files",("a.png",payload,"image/png")),("files",("b.png",b"bad","image/png"))])
    assert response.status_code == 200
    assert "32MB" in response.json()["results"][0]["reason"]
    monkeypatch.setattr(W,"MAX_IMAGE_BYTES",32*1024*1024)
    monkeypatch.setattr(W,"MAX_BATCH_BYTES",len(payload)*2-1)
    response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
        data={"params":"{}","samples":json.dumps(refs)},
        files=[("files",("a.png",payload,"image/png")),("files",("b.png",payload,"image/png"))])
    assert response.status_code == 413


def test_validation_concurrency_guard(headers):
    from api import workspaces as W
    wid = workspace(headers)["id"]
    assert W._validation_slots.acquire(blocking=False)
    try:
        response = client.post(f"/api/workspaces/{wid}/validate",headers=headers,
            data={"params":"{}","samples":json.dumps([{"id":"x","input_contract":input_contract({})}])},
            files={"files":("p.png",png(),"image/png")})
        assert response.status_code == 429
    finally:
        W._validation_slots.release()


def test_recipe_zero_delta_and_unrepresentable_number_rejected():
    empty = recipe()
    empty["operations"]["contrast"]["value"] = 0
    with pytest.raises(RecipeError,match="有效"):
        validate_recipe(empty)
    with pytest.raises(RecipeError,match="有限"):
        validate_recipe(recipe(temp={"mode":"add","value":10**1000}))
    candidate,_ = apply_recipe(recipe(hue={"mode":"add","value":.1}),{})
    assert candidate["hue"] == (.1+180)%360-180


def test_recipe_cannot_disguise_effect_as_dependency(headers):
    candidate = recipe(temp={"mode":"set","value":3000,"dependency":True})
    response = client.post("/api/luts",headers=headers,json={"name":"bad","kind":"portable_style","recipe":candidate})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_dependency"
    assert response.json()["detail"]["fields"] == ["temp"]


def test_deleted_asset_revisions_cannot_apply_but_saved_version_survives(headers):
    wid = workspace(headers)["id"]
    asset = client.post("/api/luts",headers=headers,json={"name":"style","kind":"portable_style","recipe":recipe()}).json()
    version = client.post(f"/api/workspaces/{wid}/versions",headers=headers,json={
        "name":"retain","params":asset["params"],"recipe":asset["recipe"],"source":{"asset_revision_id":asset["revision_id"]}}).json()
    assert client.delete(f"/api/luts/{asset['id']}",headers=headers).status_code == 204
    assert client.post(f"/api/luts/{asset['id']}/apply",headers=headers,
        json={"params":{},"revision_id":asset["revision_id"]}).status_code == 404
    assert client.get(f"/api/luts/{asset['id']}/download?target=neutral&revision_id={asset['revision_id']}",headers=headers).status_code == 404
    assert client.get(f"/api/workspaces/{wid}/versions/{version['id']}",headers=headers).json()["recipe"] == asset["recipe"]


def test_add_delta_legal_on_current_but_neutral_candidate_must_be_legal(headers):
    conditional = recipe(gamma={"mode":"add","value":[.8,0,0]})
    candidate,_ = apply_recipe(conditional,{"gamma":[.6,1,1]})
    assert candidate["gamma"][0] == pytest.approx(1.4)
    response = client.post("/api/luts",headers=headers,json={"name":"conditional","kind":"portable_style","recipe":conditional})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "out_of_range"


def test_concurrent_rename_preserves_new_params_and_source(headers,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from api import main as M
    asset = client.post("/api/luts",headers=headers,json={"name":"old","params":{},"source":{"value":1}}).json()
    params_ready,rename_ready = Event(),Event()
    allow_params,allow_rename = Event(),Event()
    original_content,original_update = M._asset_content,db.update_lut

    def coordinated_content(body,existing=None):
        if body.params is not None and body.params.exposure == .7:
            params_ready.set()
            assert allow_params.wait(10),"参数更新未获同步释放"
        return original_content(body,existing)

    def coordinated_update(*args,**kwargs):
        name = kwargs.get("name",args[2] if len(args)>2 else None)
        if name == "renamed":
            rename_ready.set()
            assert allow_rename.wait(10),"重命名未获同步释放"
        return original_update(*args,**kwargs)

    monkeypatch.setattr(M,"_asset_content",coordinated_content)
    monkeypatch.setattr(db,"update_lut",coordinated_update)
    route = f"/api/luts/{asset['id']}"
    with ThreadPoolExecutor(max_workers=2) as executor:
        params_future = executor.submit(client.put,route,headers=headers,
                                        json={"params":{"exposure":.7},"source":{"value":2}})
        try:
            assert params_ready.wait(10)
            rename_future = executor.submit(client.put,route,headers=headers,json={"name":"renamed"})
            assert rename_ready.wait(10)
            allow_params.set()
            assert params_future.result(timeout=10).status_code == 200
            allow_rename.set()
            renamed = rename_future.result(timeout=10)
            assert renamed.status_code == 200,renamed.text
        finally:
            allow_params.set()
            allow_rename.set()
    current = client.get(route,headers=headers).json()
    assert current["name"] == "renamed"
    assert current["params"]["exposure"] == .7
    assert current["source"] == {"value":2}
    revisions = client.get(route+"/revisions",headers=headers).json()
    assert [r["revision_number"] for r in revisions] == [2,1]
    assert revisions[0]["params"]["exposure"] == .7 and revisions[0]["source"] == {"value":2}
    assert revisions[1]["params"]["exposure"] == 0


def test_asset_revision_cas_rejects_stale_update_without_revision(headers):
    asset = client.post("/api/luts",headers=headers,json={"name":"initial","params":{}}).json()
    route = f"/api/luts/{asset['id']}"
    current = client.put(route,headers=headers,json={"params":{"exposure":.4},"revision_id":asset["revision_id"]}).json()
    rejected = client.put(route,headers=headers,json={"name":"stale","revision_id":asset["revision_id"]})
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "revision_conflict"
    assert rejected.json()["detail"]["current_revision_id"] == current["revision_id"]
    assert len(client.get(route+"/revisions",headers=headers).json()) == 2
    compatible = client.put(route,headers=headers,json={"name":"legacy client rename","params":None})
    assert compatible.status_code == 200
    assert compatible.json()["params"]["exposure"] == .4


@pytest.mark.parametrize("alias",[True,False,1.0,"1",None])
def test_recipe_rejects_invalid_dual_version_marker(headers,alias):
    invalid = recipe()
    invalid["schema_version"] = alias
    response = client.post("/api/luts",headers=headers,json={"name":"bad","kind":"portable_style","recipe":invalid})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_recipe_version"
