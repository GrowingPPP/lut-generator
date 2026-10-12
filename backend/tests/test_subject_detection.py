"""人物识别使用图像证据，空响应和非法定位不会被当成有效保护区域。"""
import base64
import io
import json
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from agent import subjects
from agent.subjects import SubjectAnalysis, SubjectRegion, detect_subjects


def proposal(**overrides):
    return {"subject_mode": "portrait", "confidence": 0.96,
            "regions": [{"bounds": [0.2, 0.1, 0.4, 0.5], "kind": "face", "confidence": 0.93}],
            "reason": "可见人脸，定位框只覆盖面部。", **overrides}


def client_for(body=None, *, tool_name=None, raw=None, error=None, empty=False):
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        if error:
            raise error
        tool_calls = [] if empty else [SimpleNamespace(function=SimpleNamespace(
            name=tool_name or subjects.SUBJECT_TOOL_NAME,
            arguments=raw if raw is not None else json.dumps(body if body is not None else proposal()),
        ))]
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(tool_calls=tool_calls))],
                                   usage=SimpleNamespace(model_dump=lambda: {"total_tokens": 27}))
        return response

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), calls=calls)


@pytest.fixture(autouse=True)
def no_vision_environment(monkeypatch):
    for name in ("CHROMA_VISION_MODEL", "CHROMA_VISION_BASE_URL", "CHROMA_VISION_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def test_recognizer_sends_display_image_and_validates_regions():
    client = client_for()
    image = np.full((1800, 1200, 3), [0.4, 0.3, 0.2], dtype=np.float32)
    result, usage = detect_subjects(client, image)
    assert result["status"] == "resolved"
    assert result["source"] == "auto"
    assert result["subject_mode"] == "portrait"
    assert result["regions"] == proposal()["regions"]
    assert result["mask_mode"] == "skin_candidates"
    assert usage == {"total_tokens": 27}
    request = client.calls[0]
    content = request["messages"][-1]["content"]
    url = next(item["image_url"]["url"] for item in content if item["type"] == "image_url")
    with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as sent:
        assert sent.size == (683, 1024)
        np.testing.assert_allclose(np.asarray(sent)[500, 300] / 255, [0.4, 0.3, 0.2], atol=0.025)
    assert request["tools"][0]["function"]["name"] == subjects.SUBJECT_TOOL_NAME
    assert "source_digest" not in json.dumps(request["tools"])
    assert "input_style" not in json.dumps(request["tools"])


def test_non_portrait_keeps_warm_background_out_of_skin_regions():
    result, _ = detect_subjects(client_for(proposal(subject_mode="non_portrait", regions=[])),
                                np.full((20, 30, 3), [0.65, 0.45, 0.32], dtype=np.float32))
    assert result["status"] == "resolved"
    assert result["subject_mode"] == "non_portrait"
    assert result["regions"] == []


@pytest.mark.parametrize("body", [proposal(confidence=0.4),
    proposal(subject_mode="unknown", confidence=0.9, regions=[])])
def test_uncertain_presence_does_not_guess_person_or_skin_area(body):
    result, _ = detect_subjects(client_for(body), np.zeros((20, 30, 3), dtype=np.float32))
    assert result["status"] == "uncertain"
    assert result["subject_mode"] == "unknown"
    assert result["regions"] == []


def test_uncertain_region_is_removed_without_denying_person_presence():
    result, _ = detect_subjects(client_for(proposal(regions=[{
        "bounds": [0.2, 0.1, 0.4, 0.5], "kind": "face", "confidence": 0.4}])),
        np.zeros((20, 30, 3), dtype=np.float32))
    assert result["status"] == "resolved"
    assert result["subject_mode"] == "portrait"
    assert result["regions"] == []


@pytest.mark.parametrize("body", [
    proposal(regions=[{"bounds": [-0.1, 0.1, 0.4, 0.5], "kind": "face", "confidence": 0.9}]),
    proposal(regions=[{"bounds": [0.8, 0.1, 0.4, 0.5], "kind": "face", "confidence": 0.9}]),
    proposal(regions=[{"bounds": [0.2, 0.1, 0.4, 0.5], "kind": "tree", "confidence": 0.9}]),
    proposal(regions=[{"bounds": [0.2, 0.1, 0.4, 0.5], "kind": "face"}]),
    proposal(subject_mode="non_portrait"), proposal(confidence=float("nan")),
    proposal(regions=proposal()["regions"] * 17), proposal(source_digest="invented"),
])
def test_invalid_or_inconsistent_model_output_fails_closed(body):
    result, usage = detect_subjects(client_for(body), np.zeros((20, 30, 3), dtype=np.float32))
    assert result["status"] == "failed"
    assert result["reason"] == "invalid"
    assert result["subject_mode"] == "unknown"
    assert result["regions"] == []
    assert usage == {"total_tokens": 27}


@pytest.mark.parametrize("options,reason", [({"empty": True}, "empty"),
    ({"raw": "not json"}, "invalid"), ({"tool_name": "submit_lut_params"}, "invalid")])
def test_empty_or_other_tool_response_is_not_completion(options, reason):
    result, usage = detect_subjects(client_for(**options), np.zeros((20, 30, 3), dtype=np.float32))
    assert result["status"] == "failed"
    assert result["reason"] == reason
    assert usage == {"total_tokens": 27}


def test_provider_failure_does_not_interrupt_grading_or_expose_response():
    result, usage = detect_subjects(client_for(error=RuntimeError("secret-provider-response")),
                                   np.zeros((20, 30, 3), dtype=np.float32))
    assert result["status"] == "failed"
    assert result["reason"] == "failed"
    assert "secret" not in json.dumps(result)
    assert usage == {}


def test_disabled_does_not_encode_or_send_image(monkeypatch):
    monkeypatch.setattr(subjects, "to_data_url", lambda *args, **kwargs: pytest.fail("image encoded"))
    client = client_for()
    result, usage = detect_subjects(client, np.zeros((20, 30, 3)), enabled=False)
    assert result["status"] == "disabled"
    assert result["reason"] == "disabled"
    assert usage == {}
    assert client.calls == []


def test_no_client_does_not_create_client_from_vision_config(monkeypatch):
    monkeypatch.setenv("CHROMA_VISION_API_KEY", "test-only-key")
    monkeypatch.setattr(subjects, "get_subject_client", lambda *args: pytest.fail("client created"))
    result, _ = detect_subjects(None, np.zeros((20, 30, 3)))
    assert result["status"] == "failed"
    assert result["reason"] == "no_client"


def test_configured_vision_model_reuses_existing_client(monkeypatch):
    monkeypatch.setenv("CHROMA_VISION_MODEL", "vision-test")
    client = client_for()
    result, _ = detect_subjects(client, np.zeros((20, 30, 3)))
    assert result["status"] == "resolved"
    assert client.calls[0]["model"] == "vision-test"


def test_separate_vision_endpoint_and_key_use_configured_client(monkeypatch):
    created = []
    vision = client_for()
    monkeypatch.setenv("CHROMA_VISION_BASE_URL", "https://vision.invalid/v1")
    monkeypatch.setenv("CHROMA_VISION_API_KEY", "test-only-key")
    monkeypatch.setattr(subjects, "OpenAI", lambda **kwargs: created.append(kwargs) or vision)
    fallback = client_for()
    result, _ = detect_subjects(fallback, np.zeros((20, 30, 3)))
    assert result["status"] == "resolved"
    assert len(created) == 1
    assert created[0]["base_url"] == "https://vision.invalid/v1"
    assert created[0]["api_key"] == "test-only-key"
    assert fallback.calls == []
    assert len(vision.calls) == 1


def test_analysis_allows_server_binding_but_disallows_automatic_all_pixels():
    data = {"version": "subject-regions-1", "status": "resolved", "source": "auto",
            "mask_mode": "skin_candidates", "source_digest": "a" * 64, "input_style": "STD",
            **proposal()}
    assert SubjectAnalysis.model_validate(data).source_digest == "a" * 64
    with pytest.raises(ValidationError):
        SubjectAnalysis.model_validate({**data, "mask_mode": "all_pixels"})
    assert SubjectAnalysis.model_validate({**data, "source": "manual", "mask_mode": "all_pixels"})


@pytest.mark.parametrize("bounds", [[True, 0.1, 0.4, 0.5], [0.2, 0.1, 0.2, 0.5],
                                   [0.2, 0.1, float("inf"), 0.5]])
def test_region_rejects_non_numeric_degenerate_and_infinite_bounds(bounds):
    with pytest.raises(ValidationError):
        SubjectRegion(bounds=bounds, kind="face", confidence=0.9)
