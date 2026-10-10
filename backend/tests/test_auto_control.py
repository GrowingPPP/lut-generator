"""实际阶段边界与安全续跑的纯编排测试。"""
from types import SimpleNamespace

import pytest

from agent import auto as A
from photo.fixtures import make_fixture
from lut_engine import LutParams
from dataclasses import asdict


def test_progress_reports_real_boundary_and_goal_skips():
    events = []
    result = A.auto_grade(make_fixture('neutral'), {}, client=None, use_vision=False,
                          context={'goal_mode': 'style_only'}, progress=events.append)
    assert result.execution_status == 'skipped'
    assert [(e['stage'], e['state']) for e in events] == [
        ('measure', 'running'), ('measure', 'done'), ('optimize', 'skipped'),
        ('style', 'skipped'), ('rules', 'skipped'), ('review', 'skipped')]


def test_cancel_before_measure_never_renders(monkeypatch):
    monkeypatch.setattr(A.R, 'render_lut', lambda *args: pytest.fail('cancelled work rendered'))
    with pytest.raises(A.AutoGradeCancelled):
        A.auto_grade(make_fixture('neutral'), {}, cancel_check=lambda: True)


@pytest.mark.parametrize('raises', [False, True])
def test_cancel_after_upstream_never_reaches_style_or_rules(raises):
    cancelled = [False]
    def propose(*args):
        cancelled[0] = True
        if raises:
            raise RuntimeError('upstream error')
        return {'exposure': .1}, '提亮', {}
    with pytest.raises(A.AutoGradeCancelled):
        A.auto_grade(make_fixture('under_exposed'), {}, '风格', client=object(), proposer=propose,
                     style_extractor=lambda *args: pytest.fail('style ran after cancellation'),
                     cancel_check=lambda: cancelled[0], use_vision=False)


def test_style_cancellation_exception_is_not_swallowed():
    def extract(*args):
        raise A.AutoGradeCancelled()
    with pytest.raises(A.AutoGradeCancelled):
        A.auto_grade(make_fixture('neutral'), {}, '风格', client=object(), context={'goal_mode': 'style_only'},
                     style_extractor=extract, use_vision=False)


def test_vision_cancellation_exception_is_not_swallowed():
    def create(**kwargs):
        raise A.AutoGradeCancelled()
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    with pytest.raises(A.AutoGradeCancelled):
        A.auto_grade(make_fixture('neutral'), {}, client=client, use_vision=True)


def test_resume_skips_completed_style_and_keeps_new_report_baseline():
    before = asdict(LutParams(contrast=.1))
    events, called = [], []
    def propose(*args):
        called.append('correction')
        return {'exposure': .1}, '继续提亮', {}
    result = A.auto_grade(make_fixture('under_exposed'), before, '风格', client=object(),
                          proposer=propose, style_extractor=lambda *args: pytest.fail('completed style reran'),
                          use_vision=False, max_rounds=1, progress=events.append,
                          resume={'skip_style': True, 'completed_style_targets': {'contrast': .1}})
    assert called == ['correction']
    assert result.steps[0].params_before['contrast'] == .1
    assert result.steps[0].params_before['exposure'] == 0
    assert result.steps[0].params_after['exposure'] == .1
    assert not any(step.stage == 'style' for step in result.steps)
    assert any(event['stage'] == 'style' and event.get('reason') == 'continued' for event in events)


def test_resume_skips_completed_correction_and_rules_but_runs_missing_style():
    called = []
    result = A.auto_grade(make_fixture('under_exposed'), {}, '风格', client=object(),
                          proposer=lambda *args: pytest.fail('completed correction reran'),
                          style_extractor=lambda *args: (called.append('style'), {'contrast': .02})[1],
                          use_vision=False, resume={'skip_correction': True})
    assert called == ['style']
    assert result.params['exposure'] == 0
    assert [step.stage for step in result.steps] == ['style']


@pytest.mark.parametrize('kind', ['failed', 'blocked', 'unchanged'])
def test_completed_style_attempt_reports_why_no_parameters_were_applied(kind):
    events = []
    def extract(*args):
        if kind == 'failed':
            raise RuntimeError('model unavailable')
        return {'contrast': .2} if kind == 'blocked' else {}
    result = A.auto_grade(make_fixture('neutral'), {}, '风格', client=object(), use_vision=False,
                          context={'goal_mode': 'style_only', 'locked_fields': ['contrast']},
                          style_extractor=extract, progress=events.append)
    done = next(event for event in reversed(events) if event['stage'] == 'style')
    assert done['state'] == 'done' and done['reason'] == kind
    assert not any(step.applied for step in result.steps)
