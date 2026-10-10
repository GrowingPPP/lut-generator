"""作业注册表纯回归，不连接数据库或调用真实模型。"""
from copy import deepcopy
from threading import Event, Thread

import pytest

from api.auto_jobs import AutoJobRegistry, JobLimitExceeded, JobNotFound, JobRequestConflict, JobRequestExpired
from agent.auto import AutoGradeCancelled


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
    assert final['stages'][0] == {'stage': 'measure', 'state': 'done', 'round': 0}


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
