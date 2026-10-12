"""作业注册表纯回归，不连接数据库或调用真实模型。"""
from copy import deepcopy
from io import BytesIO
import hashlib
import json
import sys
from threading import Event, Thread
from types import SimpleNamespace
from uuid import uuid4

import pytest

from api.auto_jobs import (AutoJobRegistry, JobLimitExceeded, JobNotFound, JobRequestConflict,
                           JobRequestExpired, JobRequestBlocked)
from agent.auto import AutoGradeCancelled


@pytest.mark.parametrize("mode,change,allowed", [
    (None, None, True), ("unknown", None, True),
    ("portrait", None, False), ("non_portrait", None, False),
    ("unknown", "file", False), ("unknown", "params", False),
    ("unknown", "recorded_subject", False),
    ("unknown", "default_subject_fields", True), ("unknown", "auto", False),
    ("unknown", "analysis", False), ("unknown", "clear_regions", False),
    ("unknown", "regions", False), ("unknown", "all_pixels", False),
    ("unknown", "recorded_detection", False),
])
def test_saved_legacy_fingerprint_replay_defaults_to_unknown_only(monkeypatch, mode, change, allowed):
    from fastapi import HTTPException, UploadFile
    from api import auto_jobs
    from api.models import LutParamsModel

    job_id, workspace_id = str(uuid4()), str(uuid4())
    raw = b"original source bytes"
    params = LutParamsModel().model_dump()
    legacy_context = {"goal_mode": "preserve", "locked_fields": []}
    payload = {"style": None, "use_vision": False, "max_rounds": 2,
               "context": legacy_context, "actual_digest": hashlib.sha256(raw).hexdigest(),
               "params": params, "workspace_id": workspace_id, "source_digest": None,
               "main_sample_id": "source", "sample_origin": "source", "continue_from": None}
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()
    saved = {"id": job_id, "status": "succeeded", "persisted": True,
             "result": {"job_fingerprint": fingerprint, "context": legacy_context}}
    monkeypatch.setitem(sys.modules, "api.main", SimpleNamespace(
        LutParamsModel=LutParamsModel, MAX_AUTO_IMAGE_BYTES=1024,
        _prepare_auto_grade=None, _compute_auto_grade=None, _persist_auto_grade=None, _reserve_auto_grade=None))
    monkeypatch.setattr(auto_jobs, "require_single_worker", lambda: None)
    monkeypatch.setattr(auto_jobs, "registry", make_registry()[0])
    monkeypatch.setattr(auto_jobs, "_saved_job", lambda *_: saved)
    context = {**legacy_context, **({"subject_mode": mode} if mode is not None else {})}
    if change == "file":
        raw += b"changed"
    elif change == "params":
        params = {**params, "exposure": .1}
    elif change == "recorded_subject":
        saved["result"]["context"] = {**legacy_context, "subject_mode": "unknown"}
    elif change == "default_subject_fields":
        context.update(subject_detection_mode="manual", subject_analysis=None,
                       skin_regions=None, skin_mask_mode="skin_candidates")
    elif change == "auto":
        context["subject_detection_mode"] = "auto"
    elif change == "analysis":
        context["subject_analysis"] = {"version": "subject-regions-1", "status": "resolved",
            "subject_mode": "non_portrait", "confidence": .9, "regions": [], "source": "auto"}
    elif change == "clear_regions":
        context["skin_regions"] = []
    elif change == "regions":
        context["skin_regions"] = [{"bounds": [.1, .2, .3, .4], "kind": "face", "confidence": .9}]
    elif change == "all_pixels":
        context["skin_mask_mode"] = "all_pixels"
    elif change == "recorded_detection":
        saved["result"]["context"] = {**legacy_context, "subject_detection_mode": "manual"}

    def replay():
        return auto_jobs.create_job(request=SimpleNamespace(headers={}),
            file=UploadFile(file=BytesIO(raw)), base_params=json.dumps(params),
            style=None, use_vision=False, max_rounds=2, workspace_id=workspace_id,
            context=json.dumps(context), source_digest=None, main_sample_id="source",
            continue_from=None, request_id=job_id, sample_origin="source", user={"id": 1})

    if allowed:
        assert replay() is saved
    else:
        with pytest.raises(HTTPException) as error:
            replay()
        assert error.value.status_code == 409


class ManualExecutor:
    def __init__(self):
        self.tasks = []

    def submit(self, fn, *args):
        self.tasks.append(lambda: fn(*args))

    def next(self):
        self.tasks.pop(0)()


def make_registry(**kwargs):
    executor = ManualExecutor()
    return AutoJobRegistry(executor=executor, **kwargs), executor


def submit(registry, run=lambda progress, cancelled: {'params': {'exposure': .1}}, persist=lambda out: out, user=1, **kwargs):
    return registry.submit(user, 'workspace', 'digest', 'sample', run, persist, **kwargs)


def test_cancel_queued_never_runs_or_saves():
    registry, executor = make_registry()
    called = []
    job = submit(registry, run=lambda *args: called.append('run'), persist=lambda out: called.append('save'))
    assert registry.cancel(job['id'], 1)['status'] == 'cancelling'
    executor.next()
    final = registry.get(job['id'], 1)
    assert final['status'] == 'cancelled'
    assert final['result'] is None and not final['persisted']
    assert called == []


def test_uncancellable_upstream_waits_for_safe_boundary():
    registry, executor = make_registry()
    entered, release = Event(), Event()
    saved = []
    def run(progress, cancelled):
        progress({'stage': 'style', 'state': 'running', 'round': 2, 'raw': 'private'})
        entered.set()
        assert release.wait(3)
        return {'params': {'exposure': .1}}
    job = submit(registry, run, lambda out: saved.append(out))
    thread = Thread(target=executor.next)
    thread.start()
    try:
        assert entered.wait(3)
        state = registry.cancel(job['id'], 1)
        assert state['status'] == 'cancelling'
        assert state['progress'] == {'stage': 'style', 'state': 'running', 'round': 2}
        assert state['result'] is None
        release.set()
        thread.join(3)
        assert not thread.is_alive()
        assert registry.get(job['id'], 1)['status'] == 'cancelled'
        assert saved == []
    finally:
        release.set()
        thread.join(3)


def test_save_boundary_wins_once_and_cannot_be_cancelled():
    registry, executor = make_registry()
    seen = []
    job = submit(registry, persist=lambda out: (seen.append(registry.cancel(job['id'], 1)), out)[1])
    executor.next()
    assert seen[0]['status'] == 'running' and not seen[0]['can_cancel']
    final = registry.cancel(job['id'], 1)
    assert final['status'] == 'succeeded' and final['persisted']
    assert registry.get(job['id'], 1)['status'] == 'succeeded'


def test_accounts_share_no_state_or_cancellation():
    registry, executor = make_registry()
    job = submit(registry)
    for action in (registry.get, registry.cancel):
        with pytest.raises(JobNotFound):
            action(job['id'], 2)
    assert registry.get(job['id'], 1)['status'] == 'queued'
    executor.next()
    with pytest.raises(JobNotFound):
        registry.get(job['id'], 2)


def test_capacity_checks_happen_before_reserving_quota():
    registry, _ = make_registry()
    charged = []
    submit(registry, reserve=lambda: charged.append(1))
    with pytest.raises(JobLimitExceeded):
        submit(registry, reserve=lambda: charged.append(2))
    submit(registry, user=2)
    with pytest.raises(JobLimitExceeded):
        submit(registry, user=3)
    assert charged == [1]


def test_idempotent_submission_reuses_job_and_rejects_changed_fingerprint():
    registry, executor = make_registry()
    charged = []
    first = submit(registry, request_id='request', fingerprint='same', reserve=lambda: charged.append(1))
    repeated = submit(registry, request_id='request', fingerprint='same', reserve=lambda: charged.append(2))
    assert first == repeated and len(executor.tasks) == 1 and charged == [1]
    with pytest.raises(JobRequestConflict):
        submit(registry, request_id='request', fingerprint='changed')
    with pytest.raises(JobNotFound):
        submit(registry, user=2, request_id='request', fingerprint='same')
    executor.next()
    assert submit(registry, request_id='request', fingerprint='same')['status'] == 'succeeded'
    assert len(executor.tasks) == 0


def test_failed_worker_and_failed_save_do_not_publish_result_or_sensitive_error():
    for failing_save in (False, True):
        registry, executor = make_registry()
        def fail(*args):
            raise RuntimeError('private-upstream-token')
        job = submit(registry, run=fail if not failing_save else lambda *args: {'params': {}},
                     persist=fail if failing_save else lambda out: out)
        executor.next()
        final = registry.get(job['id'], 1)
        assert final['status'] == 'failed' and not final['persisted'] and final['result'] is None
        assert 'private-upstream-token' not in str(final)
        assert final['error']['code'] == ('save_failed' if failing_save else 'analysis_failed')


def test_progress_uses_known_fields_and_copies_completed_results():
    registry, executor = make_registry()
    source = {'params': {'gain': [1, 1, 1]}}
    def run(progress, cancelled):
        progress({'stage': 'measure', 'state': 'done', 'secret': 'private'})
        progress({'stage': 'invented', 'state': 'done'})
        return source
    job = submit(registry, run)
    executor.next()
    final = registry.get(job['id'], 1)
    source['params']['gain'][0] = 2
    final['result']['params']['gain'][1] = 3
    assert registry.get(job['id'], 1)['result']['params']['gain'] == [1, 1, 1]
    assert final['stages'][0] == {'stage': 'subjects', 'state': 'pending', 'round': 0}
    assert final['stages'][1] == {'stage': 'measure', 'state': 'done', 'round': 0}


def test_expiration_cancels_active_at_boundary_and_reclaims_terminal():
    now = [100.0]
    registry, executor = make_registry(clock=lambda: now[0], active_seconds=10, ttl_seconds=5)
    job = submit(registry)
    now[0] = 111
    assert registry.get(job['id'], 1)['status'] == 'cancelling'
    executor.next()
    assert registry.get(job['id'], 1)['status'] == 'cancelled'
    now[0] = 117
    with pytest.raises(JobNotFound):
        registry.get(job['id'], 1)
    assert registry._jobs == {}


def test_cancellation_exception_is_a_cancelled_terminal():
    registry, executor = make_registry()
    def run(*args):
        raise AutoGradeCancelled()
    job = submit(registry, run)
    executor.next()
    assert registry.get(job['id'], 1)['status'] == 'cancelled'


def test_expired_request_receipt_never_reexecutes_the_original_id():
    now = [100.0]
    registry, executor = make_registry(clock=lambda: now[0], ttl_seconds=5)
    submit(registry, request_id='request', fingerprint='same')
    executor.next()
    now[0] = 106
    with pytest.raises(JobRequestExpired):
        submit(registry, request_id='request', fingerprint='same')
    with pytest.raises(JobRequestConflict):
        submit(registry, request_id='request', fingerprint='other')
    with pytest.raises(JobNotFound):
        submit(registry, user=2, request_id='request', fingerprint='same')
    assert not executor.tasks


def test_unregistered_request_fence_blocks_late_admission_under_the_same_lock():
    registry, executor = make_registry()
    cancelled = registry.prevent_late('request', 1, 'workspace')
    assert cancelled['status'] == 'cancelled' and cancelled['not_accepted']
    assert cancelled['result'] is None and not cancelled['persisted']
    with pytest.raises(JobRequestBlocked):
        submit(registry, request_id='request', fingerprint='same')
    with pytest.raises(JobNotFound):
        registry.prevent_late('request', 2, 'workspace')
    with pytest.raises(JobNotFound):
        registry.prevent_late('request', 1, 'other-workspace')
    assert not executor.tasks


def test_fence_cancels_existing_job_but_does_not_override_save_commit():
    registry, executor = make_registry()
    job = submit(registry, request_id='queued')
    assert registry.prevent_late(job['id'], 1, 'workspace')['status'] == 'cancelling'
    executor.next()
    assert registry.get(job['id'], 1)['status'] == 'cancelled'
    seen = []
    saved = submit(registry, request_id='saved', fingerprint='fingerprint',
                   persist=lambda result: (seen.append(registry.prevent_late('saved', 1, 'workspace')), result)[1])
    executor.next()
    assert seen[0]['can_cancel'] is False and seen[0]['status'] == 'running'
    final = registry.get(saved['id'], 1)
    assert final['status'] == 'succeeded' and final['result']['job_id'] == 'saved'
    assert final['result']['job_fingerprint'] == 'fingerprint'


def test_completed_report_fallback_has_no_fabricated_live_stage_or_continuation(monkeypatch):
    from api import auto_jobs
    from storage import db
    registry, _ = make_registry()
    monkeypatch.setattr(auto_jobs, 'registry', registry)
    payload = {'job_id': 'job', 'params': {'exposure': .1}, 'workspace_id': 'workspace'}
    monkeypatch.setattr(db, 'find_auto_job_report',
                        lambda user, job, workspace=None: deepcopy(payload)
                        if user == 1 and job == 'job' and workspace in {None, 'workspace'} else None)
    result = auto_jobs.get_job('job', workspace_id='workspace', user={'id': 1})
    assert result['status'] == 'succeeded' and result['persisted'] and result['recovered_from_report']
    assert result['stages'] == [] and result['continuation_stages'] == []
    for user, workspace in [(2, 'workspace'), (1, 'other')]:
        with pytest.raises(Exception) as error:
            auto_jobs.get_job('job', workspace_id=workspace, user={'id': user})
        assert error.value.status_code == 404


def test_worker_scopes_account_lut_resolver_over_compute_and_continuation(monkeypatch):
    from fastapi import Request, UploadFile
    from api import auto_jobs, imported_luts
    from api.models import LutParamsModel
    from photo import render
    registry, executor = make_registry()
    monkeypatch.setattr(auto_jobs, 'registry', registry)
    monkeypatch.setattr(auto_jobs, '_saved_job', lambda *args: None)
    owner, seen = 7, []
    resolver = lambda identifier: identifier
    monkeypatch.setattr(imported_luts, 'resolver_for_user',
                        lambda user_id: resolver if user_id == owner else pytest.fail('wrong owner'))

    class Result:
        def __init__(self, data=None):
            self.data = data or {'params': LutParamsModel().model_dump()}
            self.session_id = None

        @classmethod
        def model_validate(cls, data):
            return cls(data)

        def model_dump(self):
            return {**self.data, 'session_id': self.session_id}

    def compute(*args, **kwargs):
        assert kwargs['user_id'] == owner
        assert render._LUT_RESOLVER.get() is resolver
        seen.append('compute')
        return Result()

    def continuation(*args):
        assert render._LUT_RESOLVER.get() is resolver
        seen.append('continuation')
        return []

    fake_main = SimpleNamespace(LutParamsModel=LutParamsModel, MAX_AUTO_IMAGE_BYTES=1024,
        _prepare_auto_grade=lambda *args: ('image', 'params', 'context'),
        _compute_auto_grade=compute, _persist_auto_grade=lambda *args: 3,
        _reserve_auto_grade=lambda user: None, AutoGradeOut=Result)
    monkeypatch.setitem(sys.modules, 'api.main', fake_main)
    monkeypatch.setattr(auto_jobs, 'continuation_stages', continuation)
    monkeypatch.setenv('WEB_CONCURRENCY', '1')
    monkeypatch.setenv('CHROMA_AUTO_JOB_WORKERS', '1')
    job = auto_jobs.create_job(Request({'type': 'http'}), UploadFile(file=BytesIO(b'file')),
        json.dumps(LutParamsModel().model_dump()), None, False, 2, str(uuid4()), None,
        None, 'sample', None, str(uuid4()), 'source', {'id': owner})
    assert render._LUT_RESOLVER.get() is None
    executor.next()
    assert seen == ['compute', 'continuation']
    assert registry.get(job['id'], owner)['status'] == 'succeeded'
    assert render._LUT_RESOLVER.get() is None
