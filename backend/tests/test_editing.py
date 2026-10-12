"""创作目标、阶段权限与参数保护的纯函数回归。"""
from dataclasses import replace
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from agent import auto as A
from agent.editing import (PARAM_FIELDS, EditingContext, application_reasons,
                           normalize_context, writable_fields)
from agent.graph import run_agent
from agent.llm import extract_result
from photo import quality as Q
from photo import stats as S
from photo.fixtures import make_fixture


def _proposer(delta):
    return lambda *args: (delta, "克制校正", {})


def _unexpected_call(*args, **kwargs):
    raise AssertionError("没有可写字段时不能调用模型")


def test_context_is_metadata_and_legacy_default_is_natural():
    assert normalize_context().goal_mode == "natural"
    assert set(EditingContext.model_fields) == {"goal_mode", "locked_fields", "subject_mode"}
    assert normalize_context().subject_mode == "unknown"
    assert set(PARAM_FIELDS) == set(A.LutParams.__dataclass_fields__)
    assert normalize_context({"locked_fields": ["gamma", "gamma"]}).locked_fields == ["gamma"]


@pytest.mark.parametrize("context", [
    {"goal_mode": "sunset"}, {"locked_fields": ["clarity"]},
    {"locked_fields": [True]}, {"locked_fields": "temp"}, {"exposure": 1},
    [], False, {"subject_mode": "auto"}, {"subject_mode": True}, {"subject_mode": None},
])
def test_unknown_context_values_are_rejected(context):
    with pytest.raises(ValidationError):
        normalize_context(context)


def test_goal_conflicts_distinguish_darkness_and_warmth_from_observations():
    stats = replace(S.analyze(make_fixture("neutral")), lum_p50=0.2,
                    rgb_mean=(0.5, 0.4, 0.3), gray_world_dev=0.1)
    assert {issue.code for issue in Q.diagnose(stats)} >= {"under_exposed", "color_cast_warm"}
    assert Q.is_goal_met(stats, "preserve")
    assert not Q.is_goal_met(stats, "natural")
    assert Q.diagnose_for_goal(stats, "style_only") == []


def test_preserve_rejects_entire_correction_and_disables_rules(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (True, []))
    result = A.auto_grade(
        make_fixture("flat_haze"), {}, client=object(), use_vision=False,
        max_rounds=1, proposer=_proposer({"exposure": 0.2, "contrast": 0.1}),
        context={"goal_mode": "preserve"},
    )
    assert result.params["exposure"] == 0
    assert result.params["contrast"] == 0
    assert any("exposure" in reason for reason in result.blocked_reasons)
    assert all(not step.applied for step in result.steps)
    assert result.steps[0].params_before == result.steps[0].params_after


@pytest.mark.parametrize("goal", ["preserve", "style_only"])
def test_non_natural_modes_never_enter_gray_world_or_exposure_fallback(goal):
    image = make_fixture("under_exposed")
    before = A.clamp_params({"temp": 700, "exposure": -0.1})
    result = A.auto_grade(image, before, client=None, context={"goal_mode": goal})
    assert result.params == before
    assert A.conservative_solution(S.analyze(image), before, context={"goal_mode": goal}) == before


def test_style_only_skips_correction_and_allows_explicit_exposure(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (True, []))
    result = A.auto_grade(
        make_fixture("under_exposed"), {}, "明确提亮", client=object(), use_vision=False,
        proposer=_unexpected_call,
        style_extractor=lambda client, text, params: {"exposure": 0.2},
        context={"goal_mode": "style_only"},
    )
    assert result.params["exposure"] == 0.2
    assert result.goal_status == "met"
    assert [step.stage for step in result.steps] == ["style"]
    assert result.steps[0].purpose == "style"
    assert result.steps[0].params_before["exposure"] == 0
    assert result.steps[0].params_after["exposure"] == 0.2


def test_preserve_allows_explicit_style_to_change_warmth(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (True, []))
    result = A.auto_grade(
        make_fixture("neutral"), {"temp": 600}, "再暖一点", client=object(), use_vision=False,
        style_extractor=lambda client, text, params: {"temp": params["temp"] + 300},
        context={"goal_mode": "preserve"},
    )
    assert result.params["temp"] == 900
    assert result.steps[-1].params_before["temp"] == 600
    assert result.steps[-1].params_after["temp"] == 900


def test_locked_correction_rejects_all_fields_and_rules_preserve_locks(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (True, []))
    before = A.clamp_params({"temp": 350})
    result = A.auto_grade(
        make_fixture("flat_haze"), before, client=object(), use_vision=False, max_rounds=1,
        proposer=_proposer({"exposure": 0.3, "contrast": 0.1}),
        context={"locked_fields": ["exposure", "temp"]},
    )
    assert result.params == before
    assert result.steps[0].applied is False
    assert any("exposure" in reason for reason in result.blocked_reasons)


def test_all_locked_stages_skip_model_including_review():
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=_unexpected_call)))
    result = A.auto_grade(
        make_fixture("under_exposed"), {}, "暖调", client=client,
        proposer=_unexpected_call, style_extractor=_unexpected_call,
        context={"locked_fields": list(PARAM_FIELDS)},
    )
    assert result.params == A.clamp_params({})
    assert result.execution_status == "skipped"
    assert result.review_skip_reason == "locked"
    assert result.blocked_reasons


def test_locked_style_retries_once_with_unchanged_baseline(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (True, []))
    calls = []

    def extractor(client, text, params):
        calls.append((text, params))
        if len(calls) == 1:
            return {"exposure": 0.1, "contrast": 0.1}
        return {"contrast": 0.15}

    result = A.auto_grade(
        make_fixture("neutral"), {}, "增加层次", client=object(), use_vision=False,
        style_extractor=extractor, context={"locked_fields": ["exposure"]},
    )
    assert len(calls) == 2
    assert "exposure" in calls[1][0]
    assert calls[1][1] == calls[0][1]
    assert result.params["exposure"] == 0
    assert result.params["contrast"] == 0.15
    assert result.style_applied
    assert result.steps[0].params_before == result.steps[0].params_after
    assert result.steps[1].params_before["contrast"] == 0
    assert result.steps[1].params_after["contrast"] == 0.15


def test_locked_rgb_zero_delta_is_legal_and_changed_channel_is_conflict():
    base = A.clamp_params({})
    context = {"locked_fields": ["gain", "exposure"]}
    same = A.merge_params(base, {"gain": [0, 0, 0], "exposure": 0})
    assert application_reasons(base, same, context, "correction") == []
    altered = A.merge_params(base, {"gain": [0, 0.1, 0]})
    assert any("gain" in reason for reason in application_reasons(base, altered, context, "correction"))


def test_dialogue_rejects_entire_locked_proposal_and_exposes_no_contribution():
    before = {"temp": 350.0}
    result = run_agent(lambda text: {"intent": "describe", "temp": 600, "contrast": 0.1},
                       "更暖一点", before, context={"locked_fields": ["temp"]})
    assert result["params"] == before
    assert result["route"] == "blocked"
    assert result["steps"] == []
    assert "temp" in result["reply"]


def test_dialogue_checks_locked_defaults_even_for_sparse_params():
    result = run_agent(lambda text: {"intent": "describe", "exposure": 0.2},
                       "提亮", {"contrast": 0.1}, context={"locked_fields": ["exposure"]})
    assert result["params"] == {"contrast": 0.1}
    assert result["blocked_reasons"]


def test_dialogue_all_locked_does_not_extract():
    result = run_agent(_unexpected_call, "提亮", context={"locked_fields": list(PARAM_FIELDS)})
    assert result["execution_status"] == "skipped"
    assert result["params"] == {}


def test_extraction_sends_context_and_skips_all_locked():
    captured = {}

    def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(choices=[])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    extract_result(client, "暖调", context={"goal_mode": "preserve", "locked_fields": ["gamma"]})
    prompt = captured["messages"][1]["content"]
    assert "preserve" in prompt and "gamma" in prompt and "不要默认视为错误" in prompt
    captured.clear()
    assert extract_result(client, "提亮", context={"locked_fields": list(PARAM_FIELDS)}) == {}
    assert captured == {}


def test_stage_parameter_snapshots_do_not_share_rgb_arrays(monkeypatch):
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (True, []))
    result = A.auto_grade(
        make_fixture("neutral"), {}, "红通道提亮", client=object(), use_vision=False,
        style_extractor=lambda client, text, params: {"gamma": [1.1, 1, 1]},
    )
    step = result.steps[-1]
    result.params["gamma"][0] = 1.2
    assert step.params_before["gamma"] == [1, 1, 1]
    assert step.params_after["gamma"] == [1.1, 1, 1]


def test_correction_writable_fields_follow_goal_and_locks():
    assert not writable_fields({"goal_mode": "style_only"}, "correction")
    assert not writable_fields({"goal_mode": "preserve"}, "rules")
    allowed = writable_fields({"goal_mode": "preserve", "locked_fields": ["gamma"]}, "correction")
    assert not allowed & {"exposure", "temp", "tint", "gamma"}
    assert "contrast" in allowed
