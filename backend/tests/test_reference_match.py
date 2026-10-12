"""参考图分布匹配的权限、风险尺度和来源契约。"""
import hashlib
import io
import json

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from agent.reference import match_reference, matching_features
from agent.subjects import SubjectAnalysis, SubjectRegion
from api import auth
from api.models import LutParamsModel
from api import reference_match as route
from lut_engine.imported import CubeError


def source_image():
    values = np.linspace(0.15, 0.72, 32, dtype=np.float32)
    return np.stack(list(np.meshgrid(values, values, indexing="ij")) + [np.full((32, 32), 0.36)], axis=-1)


def test_same_reference_is_identity_and_strength_zero_preserves_all_parameters():
    image = source_image()
    params = LutParamsModel().model_dump()
    result = match_reference(image, image, params, strength=0)
    assert result["params"] == params
    assert result["changed_fields"] == []
    assert result["model_called"] is False
    assert result["distance_after"] == pytest.approx(result["distance_before"])


def test_matching_changes_only_allowed_parameters_and_can_improve_distribution():
    image = source_image()
    reference = np.clip(image * [0.9, 1, 1.13], 0, 1).astype(np.float32)
    params = LutParamsModel(exposure=0.12, temp=70).model_dump()
    result = match_reference(image, reference, params, {"goal_mode":"preserve", "locked_fields":["gain"]})
    assert result["distance_after"] <= result["distance_before"]
    assert result["distance_after"] < result["distance_before"]
    for field in ("exposure", "temp", "tint", "gain", "base_photo_style", "tone_map", "curve_points", "external_lut_id"):
        assert result["params"][field] == params[field]


def test_all_parameters_locked_preserves_candidate():
    params = LutParamsModel().model_dump()
    result = match_reference(source_image(), np.full((32, 32, 3), 0.4, np.float32), params,
                             {"goal_mode":"natural", "locked_fields":list(params)})
    assert result["params"] == params
    assert result["changed_fields"] == []


def test_final_risk_check_uses_existing_measurement_scale(monkeypatch):
    import agent.auto as auto
    checked = []
    monkeypatch.setattr(auto, "check_hard_rules", lambda *args: (checked.append(args[5].shape) or True, []))
    image = np.full((512, 768, 3), 0.4, np.float32)
    match_reference(image, image, LutParamsModel().model_dump(), strength=0)
    assert checked == [(341, 512, 3)]


@pytest.mark.parametrize("strength", [-0.1, 1.1, True, float("nan")])
def test_invalid_strength_rejected(strength):
    with pytest.raises(ValueError):
        match_reference(source_image(), source_image(), LutParamsModel().model_dump(), strength=strength)


def test_empty_features_rejected():
    with pytest.raises(ValueError):
        matching_features(source_image(), color=False, tone=False)


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[auth.get_current_user] = lambda: {"id":991}
    monkeypatch.setattr(route, "require_workspace", lambda ws, user: {"id":ws})
    monkeypatch.setattr(route.db, "reserve_auth_event", lambda *args: (True,0))
    monkeypatch.setattr(route, "match_reference", lambda image, target, params, ctx, **options:
                        {"before_params":params, "params":params, "model_called":False, **options})
    return TestClient(app)


def request_data():
    output = io.BytesIO()
    Image.new("RGB", (5, 4), (80, 100, 130)).save(output,"PNG")
    raw = output.getvalue()
    data = {"params":json.dumps(LutParamsModel().model_dump()),
            "context":json.dumps({"goal_mode":"preserve", "locked_fields":[]}),
            "workspace_id":"d6f7b616-60bd-4869-9401-3d25e8891468", "main_sample_id":"source",
            "source_digest":hashlib.sha256(raw).hexdigest()}
    files = {"file":("source.png",raw), "reference":("reference.png",raw)}
    return data,files


def test_api_returns_frozen_source_and_reference_identity(client):
    data,files = request_data()
    response = client.post("/api/reference/match", data=data, files=files)
    assert response.status_code == 200
    result = response.json()
    assert result["source_digest"] == result["reference_digest"] == data["source_digest"]
    assert result["workspace_id"] == data["workspace_id"]
    assert result["context"]["goal_mode"] == "preserve"
    assert result["model_called"] is False


def test_api_rejects_stale_source_and_unknown_fields(client):
    data,files = request_data()
    response = client.post("/api/reference/match", data={**data,"source_digest":"0"*64}, files=files)
    assert response.status_code == 409
    response = client.post("/api/reference/match", data={**data,"params":'{"unknown":1}'}, files=files)
    assert response.status_code == 422
    response = client.post("/api/reference/match", data={**data,"color":"false","tone":"false"}, files=files)
    assert response.status_code == 422


def test_signal_conflict_is_actionable_422(client, monkeypatch):
    def conflict(*args,**kwargs):
        raise CubeError("signal_conflict", "输入和输出编码冲突")
    monkeypatch.setattr(route,"match_reference",conflict)
    data,files=request_data()
    assert client.post("/api/reference/match",data=data,files=files).status_code == 422


@pytest.mark.parametrize("changes", [{"source_digest":"b"*64},{"input_style":"NAT"}])
def test_reference_rejects_subject_regions_bound_to_another_source(client,changes):
    data,files = request_data()
    analysis = SubjectAnalysis(status="resolved",subject_mode="portrait",confidence=.95,
        regions=[SubjectRegion(bounds=[.1,.1,.3,.3],kind="face",confidence=.9)],
        source_digest=data["source_digest"],input_style="STD").model_dump()
    data["context"] = json.dumps({"subject_detection_mode":"auto","subject_analysis":{**analysis,**changes}})
    response = client.post("/api/reference/match",data=data,files=files)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "subject_source_conflict"
