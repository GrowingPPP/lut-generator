"""参考匹配与逐图验证使用相同的局部人物证据，排除暖色背景。"""
import hashlib
import io

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from agent.reference import match_reference
from api.models import LutParamsModel
from api.workspaces import ValidationSample, measure_sample
from lut_engine import input_contract
from photo import render as R


def photo_bytes():
    out = io.BytesIO()
    Image.new("RGB", (100, 100), (166, 115, 82)).save(out, format="PNG")
    return out.getvalue()


def detected(raw, **overrides):
    return {"version": "subject-regions-1", "status": "resolved", "source": "auto",
            "subject_mode": "portrait", "confidence": 0.95, "mask_mode": "skin_candidates",
            "regions": [{"bounds": [0, 0, 0.1, 0.1], "kind": "face", "confidence": 0.95}],
            "source_digest": hashlib.sha256(raw).hexdigest(), "input_style": "STD", **overrides}


def sample(raw, **overrides):
    return ValidationSample.model_validate({"id": "sample", "input_contract": input_contract({}),
        "source_digest": hashlib.sha256(raw).hexdigest(), **overrides})


def measure(raw, ref):
    params = LutParamsModel().model_dump()
    lut = R.lut_from_params(params)
    return measure_sample(raw, ref, params, lut, lut)


def test_person_without_localized_region_does_not_protect_warm_landscape():
    raw = photo_bytes()
    result = measure(raw, sample(raw, subject_mode="portrait"))
    assert result["subject_mode"] == "portrait"
    assert result["skin_pixels"] == 0
    assert result["skin_protection_applied"] is False
    assert result["skin_measurable"] is False


def test_small_face_region_is_measurable_without_global_two_percent_threshold():
    raw = photo_bytes()
    result = measure(raw, sample(raw, subject_detection_mode="auto", subject_analysis=detected(raw)))
    assert result["subject_mode"] == "portrait"
    assert result["skin_pixels"] == 100
    assert result["baseline"]["skin_ratio"] == pytest.approx(0.01)
    assert result["skin_measurable"] is True
    assert result["skin_protection_applied"] is True
    assert result["subject_protection"]["source"] == "auto"


def test_manual_region_override_and_whole_region_mode_are_reported():
    raw = photo_bytes()
    result = measure(raw, sample(raw, subject_detection_mode="manual", subject_mode="portrait",
        skin_regions=[{"bounds": [0, 0, 0.2, 0.2], "kind": "exposed_skin", "confidence": 1}],
        skin_mask_mode="all_pixels"))
    assert result["skin_pixels"] == 400
    assert result["subject_protection"]["source"] == "manual"
    assert result["subject_protection"]["mask_mode"] == "all_pixels"


@pytest.mark.parametrize("analysis_changes", [{"source_digest": "other-photo"}, {"input_style": "NAT"},
                                            {"source_digest": None}, {"input_style": None}])
def test_validation_rejects_subject_evidence_bound_to_different_photo_or_input(analysis_changes):
    raw = photo_bytes()
    with pytest.raises(ValidationError):
        sample(raw, subject_detection_mode="auto", subject_analysis=detected(raw, **analysis_changes))


def test_reference_checks_only_localized_face_instead_of_warm_background(monkeypatch):
    import agent.auto as auto
    calls = []

    def check(*args):
        calls.append(args)
        return True, []

    monkeypatch.setattr(auto, "check_hard_rules", check)
    image = np.full((100, 100, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    context = {"subject_detection_mode": "auto", "subject_mode": "unknown",
               "subject_analysis": detected(photo_bytes())}
    result = match_reference(image, image, LutParamsModel().model_dump(), context, strength=0)
    assert calls[0][6].sum() == 100
    assert calls[0][7].subject_mode == "portrait"
    assert result["subject_protection"]["enabled"] is True
    assert result["subject_protection"]["source"] == "auto"


def test_reference_without_region_never_falls_back_to_full_image(monkeypatch):
    import agent.auto as auto
    masks = []
    monkeypatch.setattr(auto, "check_hard_rules", lambda *args: (masks.append(args[6]) or True, []))
    image = np.full((100, 100, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    match_reference(image, image, LutParamsModel().model_dump(), {"subject_mode": "portrait"}, strength=0)
    assert not masks[0].any()


def test_reference_preserves_source_skin_mask_when_current_parameters_make_it_cool(monkeypatch):
    import agent.auto as auto
    masks = []
    monkeypatch.setattr(auto, "check_hard_rules", lambda *args: (masks.append(args[6]) or True, []))
    image = np.full((100, 100, 3), [0.65, 0.45, 0.32], dtype=np.float32)
    params = LutParamsModel(temp=-3000, hue=120).model_dump()
    match_reference(image, image, params, {"subject_detection_mode":"auto",
        "subject_analysis":detected(photo_bytes())}, strength=0)
    assert masks[0].sum() == 100
