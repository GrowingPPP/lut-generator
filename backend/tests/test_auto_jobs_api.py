"""自动作业的 HTTP、归属、原子保存与正式候选续跑契约。"""
from copy import deepcopy
import hashlib
import json
from threading import Event, Thread
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from api.auth import create_token
from api.main import app, AutoGradeOut, AutoGradeStepOut, LutParamsModel
from api import auto_jobs
from photo.fixtures import make_jpeg_bytes
from storage import db


class ManualExecutor:
    def __init__(self):
        self.tasks = []

    def submit(self, fn, *args):
        self.tasks.append(lambda: fn(*args))

    def next(self):
        self.tasks.pop(0)()


client = TestClient(app)
DEFAULT_PARAMS = LutParamsModel().model_dump()
CONTEXT = {"goal_mode": "natural", "locked_fields": [], "subject_mode": "unknown"}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    db.clear_all()
    db.clear_sessions()
    db.clear_users()
    monkeypatch.setenv("CHROMA_FAKE_GRADE", "1")
    monkeypatch.setenv("CHROMA_AUTO_JOB_WORKERS", "1")
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    executor = ManualExecutor()
    jobs = auto_jobs.AutoJobRegistry(executor=executor)
    monkeypatch.setattr(auto_jobs, "registry", jobs)
    yield jobs, executor
    db.clear_all()
    db.clear_sessions()
    db.clear_users()


@pytest.fixture()
def owner():
    uid = db.create_user("job-owner", "unused-hash")
    headers = {"Authorization": f"Bearer {create_token(uid, 0)}"}
    response = client.post("/api/workspaces", headers=headers, json={"name": "照片工作区"})
    assert response.status_code == 200, response.text
    return uid, headers, response.json()["id"]


def request_data(wid, *, raw=None, params=None, **values):
    raw = raw if raw is not None else make_jpeg_bytes("under_exposed")
    data = {"base_params": json.dumps(params or DEFAULT_PARAMS), "context": json.dumps(CONTEXT),
            "use_vision": "false", "request_id": str(uuid4()), "main_sample_id": "main-photo",
            "source_digest": hashlib.sha256(raw).hexdigest()}
    if wid:
        data["workspace_id"] = wid
    data.update(values)
    return raw, data


def post(headers, raw, data):
    return client.post("/api/auto/jobs", headers=headers, data=data,
                       files={"file": ("source.jpg", raw, "image/jpeg")})


def state(headers, job_id):
    response = client.get(f"/api/auto/jobs/{job_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def report(headers, wid):
    return client.get("/api/auto/report", params={"workspace_id": wid}, headers=headers).json()


def test_original_sync_and_new_job_both_persist_the_same_formal_parameters(owner, clean):
    _, headers, wid = owner
    jobs, executor = clean
    raw, data = request_data(wid)
    submitted = post(headers, raw, data)
    assert submitted.status_code == 202, submitted.text
    assert submitted.json()["status"] == "queued"
    executor.next()
    final = state(headers, data["request_id"])
    assert final["status"] == "succeeded" and final["persisted"]
    result = final["result"]
    assert result["before_params"] == DEFAULT_PARAMS
    assert result["context"] == CONTEXT
    assert result["workspace_id"] == wid
    assert result["source_digest"] == hashlib.sha256(raw).hexdigest()
    assert result["main_sample_id"] == "main-photo"
    assert report(headers, wid) == result
    assert len(db.list_messages(result["session_id"], owner[0])) == 1
    sync_data = {key: value for key, value in data.items() if key != "request_id"}
    sync = client.post("/api/auto/grade", headers=headers, data=sync_data,
                       files={"file": ("source.jpg", raw, "image/jpeg")})
    assert sync.status_code == 200, sync.text
    assert sync.json()["params"] == result["params"]
    assert sync.json()["steps"] == result["steps"]
    assert not jobs.get(data["request_id"], owner[0])["can_cancel"]


def test_replayed_uuid_is_one_task_one_quota_and_conflicting_conditions_are_rejected(owner, clean, monkeypatch):
    import api.main as main
    _, headers, wid = owner
    _, executor = clean
    quota = []
    monkeypatch.setattr(main, "_reserve_auto_grade", lambda uid: quota.append(uid))
    raw, data = request_data(wid)
    first = post(headers, raw, data)
    assert first.status_code == 202
    assert post(headers, raw, data).json() == first.json()
    assert len(executor.tasks) == 1 and quota == []
    changed = {**data, "base_params": json.dumps({**DEFAULT_PARAMS, "contrast": .1})}
    assert post(headers, raw, changed).status_code == 409
    changed_subject = {**data, "context": json.dumps({**CONTEXT, "subject_mode": "portrait"})}
    assert post(headers, raw, changed_subject).status_code == 409
    other_raw, other = request_data(wid, raw=make_jpeg_bytes("neutral"), request_id=data["request_id"])
    assert post(headers, other_raw, other).status_code == 409
    executor.next()
    assert quota == [owner[0]]
    assert post(headers, raw, data).json()["status"] == "succeeded"
    assert not executor.tasks
    assert len(db.list_messages(report(headers, wid)["session_id"], owner[0])) == 1


def test_account_cannot_read_cancel_replay_or_continue_another_accounts_job(owner, clean):
    _, headers, wid = owner
    _, executor = clean
    raw, data = request_data(wid)
    assert post(headers, raw, data).status_code == 202
    other_id = db.create_user("other-job-owner", "unused-hash")
    other = {"Authorization": f"Bearer {create_token(other_id, 0)}"}
    path = f"/api/auto/jobs/{data['request_id']}"
    for response in (client.get(path, headers=other), client.delete(path, headers=other), post(other, raw, data)):
        assert response.status_code == 404
        assert "params" not in response.text and "source_digest" not in response.text
    assert state(headers, data["request_id"])["status"] == "queued"
    executor.next()


def test_queued_cancel_does_not_create_a_session_message_or_workspace_report(owner, clean):
    uid, headers, wid = owner
    _, executor = clean
    raw, data = request_data(wid)
    assert post(headers, raw, data).status_code == 202
    response = client.delete(f"/api/auto/jobs/{data['request_id']}", headers=headers)
    assert response.json()["status"] == "cancelling"
    executor.next()
    final = state(headers, data["request_id"])
    assert final["status"] == "cancelled" and final["result"] is None and not final["persisted"]
    assert db.get_workspace(wid, uid)["session_id"] is None
    assert not db.list_sessions(uid) and report(headers, wid) is None


def test_running_cancel_waits_for_upstream_then_discards_candidate_without_persistence(owner, clean, monkeypatch):
    import api.main as main
    uid, headers, wid = owner
    _, executor = clean
    entered, release = Event(), Event()
    original = main._compute_auto_grade
    def blocked(*args, **kwargs):
        kwargs["progress"]({"stage": "style", "state": "running", "round": 1})
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(main, "_compute_auto_grade", blocked)
    raw, data = request_data(wid)
    assert post(headers, raw, data).status_code == 202
    worker = Thread(target=executor.next)
    worker.start()
    try:
        assert entered.wait(5)
        cancelled = client.delete(f"/api/auto/jobs/{data['request_id']}", headers=headers).json()
        assert cancelled["status"] == "cancelling" and cancelled["result"] is None
        assert not db.list_sessions(uid)
        release.set()
        worker.join(5)
        assert not worker.is_alive()
        assert state(headers, data["request_id"])["status"] == "cancelled"
        assert report(headers, wid) is None and not db.list_sessions(uid)
    finally:
        release.set()
        worker.join(5)


def inject_insert_failure(monkeypatch, table):
    original = db.DictCursor.execute
    def execute(cursor, query, args=None):
        if query.lstrip().startswith(f"INSERT INTO {table} "):
            raise RuntimeError("private-database-detail")
        return original(cursor, query, args)
    monkeypatch.setattr(db.DictCursor, "execute", execute)


def test_workspace_report_failure_rolls_back_new_session_message_and_binding(owner, clean, monkeypatch):
    uid, headers, wid = owner
    _, executor = clean
    inject_insert_failure(monkeypatch, "workspace_reports")
    raw, data = request_data(wid)
    assert post(headers, raw, data).status_code == 202
    executor.next()
    final = state(headers, data["request_id"])
    assert final["status"] == "failed" and final["error"]["code"] == "save_failed"
    assert final["result"] is None and not final["persisted"]
    assert "private-database-detail" not in str(final)
    assert db.get_workspace(wid, uid)["session_id"] is None
    assert not db.list_sessions(uid) and report(headers, wid) is None


def test_legacy_message_failure_rolls_back_new_auto_session(owner, clean, monkeypatch):
    uid, headers, _ = owner
    _, executor = clean
    inject_insert_failure(monkeypatch, "messages")
    raw, data = request_data(None)
    assert post(headers, raw, data).status_code == 202
    executor.next()
    assert state(headers, data["request_id"])["status"] == "failed"
    assert not db.list_sessions(uid)
    assert client.get("/api/auto/report", headers=headers).json() is None


def test_failed_second_save_keeps_only_the_previous_formal_report_and_message(owner, clean, monkeypatch):
    uid, headers, wid = owner
    _, executor = clean
    raw, first_data = request_data(wid)
    assert post(headers, raw, first_data).status_code == 202
    executor.next()
    first = report(headers, wid)
    inject_insert_failure(monkeypatch, "workspace_reports")
    _, next_data = request_data(wid, raw=raw, params={**DEFAULT_PARAMS, "contrast": .1})
    assert post(headers, raw, next_data).status_code == 202
    executor.next()
    assert state(headers, next_data["request_id"])["status"] == "failed"
    assert report(headers, wid) == first
    assert len(db.list_messages(first["session_id"], uid)) == 1


def mock_partial_candidate(monkeypatch, captured):
    import api.main as main
    def compute(img, parsed, ctx, style, use_vision, max_rounds, wid, digest, sample, **kwargs):
        before = parsed.model_dump()
        captured.append({"before": deepcopy(before), **kwargs})
        if kwargs.get("resume"):
            assert kwargs["resume"]["skip_style"] and not kwargs["resume"]["skip_correction"]
            after = {**before, "exposure": before["exposure"] + .1}
            steps = [AutoGradeStepOut(stage="optimize", round=1, diagnosis="继续校正", applied=True,
                                     params_before=before, params_after=after)]
        else:
            corrected = {**before, "exposure": .1}
            after = {**corrected, "contrast": .2}
            steps = [AutoGradeStepOut(stage="optimize", round=1, diagnosis="基础校正", applied=True,
                                     params_before=before, params_after=corrected),
                     AutoGradeStepOut(stage="style", round=1, diagnosis="风格", applied=True,
                                     params_before=corrected, params_after=after, purpose="style")]
        return AutoGradeOut(params=after, before_params=before, steps=steps,
            style_applied=not kwargs.get("resume"), style_applied_params={"contrast": .2} if not kwargs.get("resume") else None,
            style_params={"contrast": .2} if not kwargs.get("resume") else None,
            goal_status="partially_met", execution_status="model", context=ctx,
            workspace_id=wid, source_digest=digest, main_sample_id=sample,
            continued_from=kwargs.get("continued_from"))
    monkeypatch.setattr(main, "_compute_auto_grade", compute)


def test_continuation_uses_the_formal_candidate_as_a_new_request_and_report(owner, clean, monkeypatch):
    uid, headers, wid = owner
    _, executor = clean
    captured = []
    mock_partial_candidate(monkeypatch, captured)
    raw, first = request_data(wid, style="清透")
    assert post(headers, raw, first).status_code == 202
    executor.next()
    completed = state(headers, first["request_id"])
    assert completed["continuation_stages"] == ["optimize"]
    _, continuation = request_data(wid, raw=raw, params=completed["result"]["params"],
                                  style="清透", continue_from=first["request_id"])
    assert continuation["request_id"] != first["request_id"]
    assert post(headers, raw, continuation).status_code == 202
    executor.next()
    continued = state(headers, continuation["request_id"])
    assert continued["status"] == "succeeded" and continued["continued_from"] == first["request_id"]
    assert continued["result"]["before_params"] == completed["result"]["params"]
    assert [step["stage"] for step in continued["result"]["steps"]] == ["optimize"]
    assert continued["result"]["steps"][0]["params_before"] == completed["result"]["params"]
    assert captured[1]["resume"]["completed_style_targets"] == {"contrast": .2}
    assert report(headers, wid) == continued["result"]
    assert len(db.list_messages(continued["result"]["session_id"], uid)) == 2
    assert post(headers, raw, continuation).json()["id"] == continuation["request_id"]
    assert not executor.tasks


@pytest.mark.parametrize("change", ["params", "context", "subject", "workspace", "sample", "sha", "style", "vision"])
def test_continuation_rejects_changed_formal_candidate_conditions(owner, clean, monkeypatch, change):
    _, headers, wid = owner
    _, executor = clean
    mock_partial_candidate(monkeypatch, [])
    raw, first = request_data(wid, style="清透")
    assert post(headers, raw, first).status_code == 202
    executor.next()
    completed = state(headers, first["request_id"])
    _, data = request_data(wid, raw=raw, params=completed["result"]["params"], style="清透", continue_from=first["request_id"])
    if change == "params":
        data["base_params"] = json.dumps({**completed["result"]["params"], "exposure": .2})
    elif change == "context":
        data["context"] = json.dumps({"goal_mode": "preserve", "locked_fields": []})
    elif change == "subject":
        data["context"] = json.dumps({**CONTEXT, "subject_mode": "portrait"})
    elif change == "workspace":
        data["workspace_id"] = client.post("/api/workspaces", headers=headers, json={}).json()["id"]
    elif change == "sample":
        data["main_sample_id"] = "other-photo"
    elif change == "sha":
        raw = make_jpeg_bytes("neutral")
        data["source_digest"] = hashlib.sha256(raw).hexdigest()
    elif change == "style":
        data["style"] = "另一风格"
    else:
        data["use_vision"] = "true"
    response = post(headers, raw, data)
    assert response.status_code == 409, response.text
    assert not executor.tasks


def test_single_worker_configuration_is_a_definite_not_accepted_error(owner, clean, monkeypatch):
    _, headers, wid = owner
    _, executor = clean
    monkeypatch.setenv("CHROMA_AUTO_JOB_WORKERS", "2")
    raw, data = request_data(wid)
    response = post(headers, raw, data)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "single_worker_required"
    assert response.json()["detail"]["accepted"] is False
    assert not executor.tasks


def test_committed_job_restores_from_report_and_replays_without_a_live_registry(owner, clean):
    _, headers, wid = owner
    jobs, executor = clean
    raw, data = request_data(wid)
    assert post(headers, raw, data).status_code == 202
    executor.next()
    completed = state(headers, data['request_id'])
    assert completed['result']['job_id'] == data['request_id']
    assert completed['result']['job_fingerprint']
    jobs._jobs.clear()
    recovered = client.get(f"/api/auto/jobs/{data['request_id']}",
                           params={'workspace_id': wid}, headers=headers)
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()['recovered_from_report']
    assert recovered.json()['result'] == completed['result']
    assert recovered.json()['stages'] == [] and recovered.json()['continuation_stages'] == []
    repeated = post(headers, raw, data)
    assert repeated.status_code == 202 and repeated.json()['recovered_from_report']
    assert not executor.tasks
    changed = {**data, 'base_params': json.dumps({**DEFAULT_PARAMS, 'contrast': .1})}
    assert post(headers, raw, changed).status_code == 409
    assert len(db.list_messages(completed['result']['session_id'], owner[0])) == 1


def test_explicit_missing_submission_fence_prevents_a_late_post(owner, clean):
    _, headers, wid = owner
    _, executor = clean
    raw, data = request_data(wid)
    assert client.get(f"/api/auto/jobs/{data['request_id']}", headers=headers).status_code == 404
    ended = client.delete(f"/api/auto/jobs/{data['request_id']}", headers=headers,
                          params={'workspace_id': wid, 'prevent_late': 'true'})
    assert ended.status_code == 200, ended.text
    assert ended.json()['status'] == 'cancelled' and ended.json()['not_accepted']
    late = post(headers, raw, data)
    assert late.status_code == 409 and late.json()['detail']['code'] == 'request_blocked'
    assert not executor.tasks and report(headers, wid) is None


def test_job_queries_and_cancel_fence_are_scoped_to_the_receipt_workspace(owner, clean):
    _, headers, wid = owner
    _, executor = clean
    raw, data = request_data(wid)
    assert post(headers, raw, data).status_code == 202
    other = client.post('/api/workspaces', headers=headers, json={}).json()['id']
    path = f"/api/auto/jobs/{data['request_id']}"
    assert client.get(path, headers=headers, params={'workspace_id': other}).status_code == 404
    assert client.delete(path, headers=headers,
                         params={'workspace_id': other, 'prevent_late': 'true'}).status_code == 404
    assert state(headers, data['request_id'])['status'] == 'queued'
    executor.next()
    assert client.get(path, headers=headers, params={'workspace_id': other}).status_code == 404
