"""同一人物区域固定用于全部候选，暖色背景不参与肤色规则。"""
import numpy as np
import pytest
from agent import auto as A
from agent.subject_context import protection_context, protection_mask, protection_report
from photo import stats as S


def evidence(mode="portrait", regions=None, **kwargs):
    return {"version": "subject-regions-1", "status": "resolved", "source": "auto",
            "subject_mode": mode, "confidence": .95, "mask_mode": "skin_candidates",
            "regions": regions if regions is not None else [{"bounds": [0., 0., .1, .1],
                        "kind": "face", "confidence": .9}], **kwargs}


def test_small_face_is_protected_without_whole_image_two_percent_threshold():
    image = np.full((100, 100, 3), [.65, .4, .3], dtype=np.float32)
    context = {"subject_detection_mode": "auto", "subject_analysis": evidence()}
    mask = protection_mask(image, context)
    stats = S.analyze(image, mask)
    assert 32 <= mask.sum() < stats.sampled_px * .02
    assert protection_report(context, stats)["enabled"]
    assert not mask.reshape(100, 100)[50:, 50:].any()


@pytest.mark.parametrize("context", [{}, {"subject_mode": "portrait"},
    {"subject_detection_mode": "auto", "subject_analysis": evidence("non_portrait", [])},
    {"subject_detection_mode": "auto", "subject_analysis": evidence(confidence=.4)}])
def test_no_localized_evidence_never_falls_back_to_warm_background(context):
    image = np.full((60, 60, 3), [.65, .4, .3], dtype=np.float32)
    assert S.skin_mask_of(image).any()
    assert not protection_mask(image, context).any()


def test_manual_absence_and_empty_region_override_automatic_person():
    image = np.full((60, 60, 3), [.65, .4, .3], dtype=np.float32)
    context = {"subject_detection_mode": "manual", "subject_mode": "non_portrait", "subject_analysis": evidence()}
    assert protection_context(context).subject_mode == "non_portrait"
    assert not protection_mask(image, context).any()
    context.update(subject_mode="portrait", skin_regions=[])
    assert not protection_mask(image, context).any()


def test_pre_grade_detection_runs_before_proposal_and_reuses_cached_regions(monkeypatch):
    image = np.full((60, 60, 3), [.65, .4, .3], dtype=np.float32)
    calls = []
    def detect(*args, **kwargs):
        calls.append("detect")
        return evidence("non_portrait", []), {"total_tokens": 12}
    monkeypatch.setattr(A, "detect_subjects", detect)
    def proposer(*args):
        calls.append("propose")
        return {}, "保持", {}
    result = A.auto_grade(image, {}, client=object(), use_vision=False, proposer=proposer,
                          context={"subject_detection_mode": "auto"})
    assert calls[0] == "detect"
    assert result.usage["total_tokens"] == 12
    assert not result.subject_protection["enabled"]
    calls.clear()
    A.auto_grade(image, {}, client=object(), use_vision=False, proposer=proposer,
                 context={"subject_detection_mode": "auto", "subject_analysis": evidence("non_portrait", [])})
    assert "detect" not in calls


def test_disabled_detection_does_not_send_image(monkeypatch):
    class ForbiddenClient:
        @property
        def chat(self):
            raise AssertionError("disabled image analysis accessed model")
    result = A.auto_grade(np.full((30, 30, 3), .5, dtype=np.float32), {},
        client=ForbiddenClient(), use_vision=False, context={"subject_detection_mode": "auto", "locked_fields": list(A.LutParams.__dataclass_fields__)})
    assert result.subject_protection["detection"]["status"] == "disabled"
    assert not result.subject_protection["enabled"]


def test_review_uses_same_visual_configuration_as_recognition(monkeypatch):
    from types import SimpleNamespace
    calls = []
    class Client:
        def __init__(self):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self, **kwargs):
            calls.append(kwargs["model"])
            return SimpleNamespace(usage=None, choices=[SimpleNamespace(message=SimpleNamespace(content="可测效果正常"))])
    monkeypatch.setenv("CHROMA_VISION_MODEL", "dedicated-vision")
    monkeypatch.setattr(A, "get_subject_client", lambda original: Client())
    image = np.full((10, 10, 3), .3, dtype=np.float32)
    assert A.vision_review(object(), image, image + .1)[0]
    assert calls == ["dedicated-vision"]
