"""非人物颜色保护与视觉复核真实性的确定性回归。"""
from types import SimpleNamespace

import numpy as np
import pytest

from agent import auto as A


def warm_scene():
    values = np.linspace(0.65, 1.0, 32, dtype=np.float32)
    return np.tile(values[None, :, None] * np.array([0.6, 0.45, 0.25], np.float32), (32, 1, 1))


def review_client(content="画面更通透", *, no_choices=False):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        choices = [] if no_choices else [SimpleNamespace(message=SimpleNamespace(content=content))]
        return SimpleNamespace(choices=choices, usage=SimpleNamespace(model_dump=lambda: {"total_tokens": 7}))

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), calls=calls)


def test_unconfirmed_warm_scene_does_not_use_color_as_person_evidence():
    image = warm_scene()
    assert A.S.analyze(image).skin_ratio > 0.9
    result = A.auto_grade(image, {}, style="暖色风景改变色相", client=object(), use_vision=False,
                          context={"goal_mode": "style_only"},
                          style_extractor=lambda *_: {"hue": 40.0})
    assert result.style_applied
    assert result.params["hue"] == 40.0
    assert not any("肤色" in reason for reason in result.blocked_reasons)


def test_unchanged_parameters_skip_comparative_review_and_model_call():
    client = review_client()
    progress = []
    result = A.auto_grade(warm_scene(), {}, client=client, context={"goal_mode": "preserve"},
                          proposer=lambda *_: ({}, "保留当前效果", {}), progress=progress.append)
    assert result.params == A.clamp_params({})
    assert result.review is None
    assert result.review_skip_reason == "unchanged"
    assert client.calls == []
    assert {"stage": "review", "state": "skipped", "round": 0, "reason": "unchanged"} in progress


def test_changed_parameters_with_identical_render_skip_comparative_review():
    client = review_client()
    base = {"look_strength": 0.0}
    result = A.auto_grade(warm_scene(), base, "降低饱和度", client=client,
                          context={"goal_mode": "style_only"},
                          style_extractor=lambda *_: {"saturation": -0.1})
    assert result.params["saturation"] == -0.1
    assert result.params != A.clamp_params(base)
    assert result.review is None
    assert result.review_skip_reason == "unchanged"
    assert client.calls == []


@pytest.mark.parametrize("content,no_choices", [(None, False), ("  \n", False), ([], False), (None, True)])
def test_empty_review_is_not_a_successful_opinion(content, no_choices):
    client = review_client(content, no_choices=no_choices)
    before = warm_scene()
    opinion, usage, reason = A.vision_review(client, before, before * 0.9)
    assert opinion is None
    assert usage == {"total_tokens": 7}
    assert reason == "empty"


def test_quantized_identical_display_pixels_do_not_get_an_improvement_review():
    client = review_client()
    before = np.full((8, 8, 3), 100 / 255, np.float32)
    after = before + np.float32(0.00001)
    assert not np.array_equal(before, after)
    opinion, usage, reason = A.vision_review(client, before, after)
    assert opinion is None
    assert reason == "unchanged"
    assert usage == {} and client.calls == []


def test_empty_review_has_one_terminal_stage_notification():
    events = []
    result = A.auto_grade(warm_scene(), {}, "轻微降饱和", client=review_client(" "),
                          context={"goal_mode": "style_only"}, progress=events.append,
                          style_extractor=lambda *_: {"saturation": -0.1})
    assert result.review_skip_reason == "empty"
    terminal = [event for event in events if event["stage"] == "review" and event["state"] != "running"]
    assert terminal == [{"stage": "review", "state": "skipped", "round": 0, "reason": "empty"}]


@pytest.mark.parametrize("mode,applied", [("unknown", True), ("non_portrait", True), ("portrait", False)])
def test_subject_evidence_controls_only_the_person_guard(mode, applied):
    result = A.auto_grade(warm_scene(), {}, "改变色相", client=object(), use_vision=False,
                          context={"goal_mode": "style_only", "subject_mode": mode},
                          style_extractor=lambda *_: {"hue": 40.0})
    assert result.style_applied is applied
    assert result.subject_protection == {"subject_mode": mode, "enabled": mode == "portrait",
                                         "suspected_skin_ratio": 1.0, "method": "color_heuristic"}
    assert bool(result.style_rejections) is (not applied)
    if not applied:
        assert all("肤色" in reason for reason in result.style_rejections)


def test_unknown_subject_does_not_bypass_other_hard_guards():
    result = A.auto_grade(warm_scene(), {}, "强烈提亮", client=object(), use_vision=False,
                          context={"goal_mode": "style_only"},
                          style_extractor=lambda *_: {"exposure": 2.0})
    assert not result.style_applied
    assert any("曝光" in reason or "高光" in reason for reason in result.style_rejections)


@pytest.mark.parametrize("mode", ["unknown", "non_portrait", "portrait"])
def test_correction_and_rule_guards_receive_the_same_subject_evidence(monkeypatch, mode):
    from photo.fixtures import make_fixture

    original = A.check_hard_rules
    received = []

    def checked(*args, **kwargs):
        received.append(args[-1].subject_mode)
        return original(*args, **kwargs)

    monkeypatch.setattr(A, "check_hard_rules", checked)
    ctx = {"subject_mode": mode}
    A.auto_grade(warm_scene(), {}, client=object(), use_vision=False, max_rounds=1,
                 context=ctx, proposer=lambda *_: ({"saturation": -0.1}, "轻微校正", {}))
    assert received and set(received) == {mode}
    received.clear()
    A.conservative_iterative(make_fixture("under_exposed"), {}, context=ctx, max_rounds=1)
    assert received and set(received) == {mode}


def test_reference_matching_passes_the_subject_of_its_source_photo(monkeypatch):
    from agent.reference import match_reference

    received = []
    monkeypatch.setattr(A, "check_hard_rules", lambda *args: (received.append(args[-1].subject_mode) or True, []))
    image = warm_scene()
    match_reference(image, image, A.clamp_params({}), {"subject_mode": "non_portrait"}, strength=0)
    assert received == ["non_portrait"]


def test_each_batch_sample_uses_its_own_subject_annotation(monkeypatch):
    from api.workspaces import ValidationSample, measure_sample
    from lut_engine import input_contract

    image = warm_scene()
    monkeypatch.setattr(A.S, "load_image", lambda *_: image)
    params = A.clamp_params({"hue": 40.0})
    baseline_lut, current_lut = A.R.lut_from_params({}), A.R.lut_from_params(params)
    measured = {}
    for mode in ("unknown", "non_portrait", "portrait"):
        sample = ValidationSample(id=mode, input_contract=input_contract(params), subject_mode=mode)
        measured[mode] = measure_sample(b"source", sample, params, baseline_lut, current_lut)
    assert not measured["unknown"]["risks"]
    assert not measured["non_portrait"]["risks"]
    assert measured["portrait"]["risks"] == ["肤色色彩偏移"]
    assert [measured[mode]["skin_protection_applied"] for mode in measured] == [False, False, True]
    assert all(result["skin_evidence"] == "suspected_color" for result in measured.values())


def test_suspected_colors_are_not_presented_to_the_model_as_person_evidence():
    from agent.editing import context_prompt

    stats = A.S.to_prompt_dict(A.S.analyze(warm_scene()))
    assert stats["suspected_skin_ratio"] == 1.0
    assert "skin_ratio" not in stats
    assert "不能推断人物" in context_prompt({}, "correction")
    assert "不是人脸检测或人物分割" in context_prompt({"subject_mode": "portrait"}, "style")
