"""已持久化作业兼容默认字段升级，显式条件变化仍拒绝重放。"""
from copy import deepcopy
import hashlib
from io import BytesIO
import json
import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest

from api.auto_jobs import _request_fingerprint


DEFAULTS = {"subject_mode": "unknown", "subject_detection_mode": "manual",
            "subject_analysis": None, "skin_regions": None, "skin_mask_mode": "skin_candidates"}
LEGACY = {"goal_mode": "preserve", "locked_fields": []}
REGION = {"bounds": [.1, .2, .3, .4], "kind": "face", "confidence": .9}
ANALYSIS = {"version": "subject-regions-1", "status": "resolved", "subject_mode": "portrait",
            "confidence": .9, "regions": [REGION], "source": "auto", "mask_mode": "skin_candidates"}


def saved_request(old_context):
    payload = {"context": old_context, "actual_digest": "original", "params": {"exposure": 0},
               "workspace_id": "workspace", "use_vision": False, "main_sample_id": "main"}
    saved = {"job_fingerprint": _request_fingerprint(payload), "context": deepcopy(old_context)}
    return payload, saved


@pytest.mark.parametrize("old_context", [LEGACY, {**LEGACY, "subject_mode": "unknown"},
    {**LEGACY, "subject_mode": "portrait"}, {**LEGACY, "subject_mode": "non_portrait"},
    {**LEGACY, **DEFAULTS}, {**LEGACY, "skin_mask_mode": "skin_candidates", "subject_analysis": None}])
def test_default_fields_replay_each_historical_schema_without_mutating(old_context):
    from api.auto_jobs import _saved_fingerprint_matches
    payload, saved = saved_request(old_context)
    upgraded = {**payload, "context": {**DEFAULTS, **old_context}}
    before = deepcopy((saved, upgraded))
    assert _saved_fingerprint_matches(saved, upgraded)
    assert (saved, upgraded) == before


@pytest.mark.parametrize("change", [{"subject_mode": "portrait"}, {"subject_mode": "non_portrait"},
    {"subject_detection_mode": "auto"}, {"subject_analysis": ANALYSIS}, {"skin_regions": []},
    {"skin_regions": [REGION]}, {"skin_mask_mode": "all_pixels"}, {"goal_mode": "natural"},
    {"locked_fields": ["temp"]}])
def test_changed_conditions_are_never_ignored_for_legacy_replay(change):
    from api.auto_jobs import _saved_fingerprint_matches
    payload, saved = saved_request(LEGACY)
    assert not _saved_fingerprint_matches(saved, {**payload, "context": {**LEGACY, **DEFAULTS, **change}})


@pytest.mark.parametrize("change", [{"actual_digest": "changed"}, {"use_vision": True},
    {"params": {"exposure": .1}}, {"main_sample_id": "other"}, {"workspace_id": "other"}])
def test_source_parameters_and_image_permission_remain_frozen(change):
    from api.auto_jobs import _saved_fingerprint_matches
    payload, saved = saved_request(LEGACY)
    assert not _saved_fingerprint_matches(saved, {**payload, "context": {**LEGACY, **DEFAULTS}, **change})


def test_recorded_default_field_cannot_be_removed_to_match_a_different_fingerprint():
    from api.auto_jobs import _saved_fingerprint_matches
    payload, saved = saved_request(LEGACY)
    saved["context"] = {**LEGACY, "subject_detection_mode": "manual"}
    assert not _saved_fingerprint_matches(saved, {**payload, "context": {**LEGACY, **DEFAULTS}})


@pytest.mark.parametrize("context", [None, [], "invalid"])
def test_missing_saved_context_cannot_create_a_legacy_match(context):
    from api.auto_jobs import _saved_fingerprint_matches
    payload, saved = saved_request(LEGACY)
    saved["context"] = context
    assert not _saved_fingerprint_matches(saved, {**payload, "context": {**LEGACY, **DEFAULTS}})


@pytest.mark.parametrize("analysis_digest,analysis_style,declare_source", [
    ("other", "STD", True), ("same", "VLOG", True), ("same", "STD", False),
])
def test_invalid_subject_source_is_rejected_before_registering_or_charging(
        monkeypatch, analysis_digest, analysis_style, declare_source):
    from fastapi import HTTPException, UploadFile
    from api import auto_jobs
    from api.models import LutParamsModel

    raw = b"the actual uploaded source"
    digest = hashlib.sha256(raw).hexdigest()
    analysis = {**ANALYSIS, "source_digest": digest if analysis_digest == "same" else "a" * 64,
                "input_style": analysis_style}
    context = {**LEGACY, **DEFAULTS, "subject_detection_mode": "auto", "subject_analysis": analysis}
    calls = []

    def forbidden(*_args, **_kwargs):
        calls.append("registered or charged")
        pytest.fail("invalid subject source must be rejected before registration or quota reservation")

    monkeypatch.setitem(sys.modules, "api.main", SimpleNamespace(
        LutParamsModel=LutParamsModel, MAX_AUTO_IMAGE_BYTES=1024,
        _prepare_auto_grade=forbidden, _compute_auto_grade=forbidden,
        _persist_auto_grade=forbidden, _reserve_auto_grade=forbidden))
    monkeypatch.setattr(auto_jobs, "require_single_worker", lambda: None)
    monkeypatch.setattr(auto_jobs, "registry", SimpleNamespace(replay=forbidden, submit=forbidden))
    monkeypatch.setattr(auto_jobs, "_saved_job", forbidden)
    with pytest.raises(HTTPException) as error:
        auto_jobs.create_job(request=SimpleNamespace(headers={}),
            file=UploadFile(file=BytesIO(raw)), base_params=json.dumps(LutParamsModel().model_dump()),
            style=None, use_vision=False, max_rounds=2, workspace_id=str(uuid4()),
            context=json.dumps(context), source_digest=digest if declare_source else None,
            main_sample_id="source", continue_from=None, request_id=str(uuid4()),
            sample_origin="source", user={"id": 1})
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "subject_source_conflict"
    assert calls == []
