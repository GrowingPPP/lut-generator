"""工作区身份、不可变版本与无模型多样张验证。"""
import hashlib
import json
from dataclasses import asdict
from contextlib import contextmanager
from pathlib import Path
from threading import BoundedSemaphore
from typing import Literal, Optional
from uuid import UUID

import numpy as np
import pymysql
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field, field_validator

from agent.editing import EditingContext
from api import auth
from api.models import LutParamsModel, checked_metadata
from lut_engine import input_contract, validate_recipe, validate_input_contract, RecipeError
from storage import db

router = APIRouter(prefix="/api/workspaces")
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_BATCH_BYTES = 64 * 1024 * 1024
MEASUREMENT_VERSION = "rgb-exif-lanczos2048-stats512-v1"
_engine_path = Path(__file__).resolve().parents[1] / "lut_engine"
ENGINE_VERSION = "chroma-lut-" + hashlib.sha256(b"".join(
    path.read_bytes() for path in sorted(_engine_path.glob("*.py")))).hexdigest()[:12]
_validation_slots = BoundedSemaphore(1)


@contextmanager
def validation_slot():
    if not _validation_slots.acquire(blocking=False):
        raise HTTPException(429,"统计验证正在处理,请稍后重试",headers={"Retry-After":"2"})
    try:
        yield
    finally:
        _validation_slots.release()


def require_workspace(workspace_id, user_id):
    record = db.get_workspace(workspace_id, user_id)
    if not record:
        raise HTTPException(404, "工作区不存在")
    return record


def recipe_http_error(exc):
    return HTTPException(409 if exc.code in {"lock_conflict", "input_conflict"} else 422,
                         {"code": exc.code, "message": str(exc), "fields": exc.fields})


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class WorkspaceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Optional[str] = None
    session_id: Optional[int] = None
    name: str = Field("创作工作区", min_length=1, max_length=255)

    @field_validator("id")
    @classmethod
    def valid_uuid(cls, value):
        return str(UUID(value)) if value else value


class WorkspaceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: Optional[int] = None
    name: Optional[str] = Field(None, min_length=1, max_length=255)


class VersionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)
    params: LutParamsModel
    context: EditingContext = Field(default_factory=EditingContext)
    recipe: Optional[dict] = None
    source: dict = Field(default_factory=dict)
    sample_refs: list[dict] = Field(default_factory=list, max_length=5)
    validation_summary: Optional[dict] = None
    baseline: Optional[dict] = None
    recipe_projection: Optional[dict] = None
    input_status: Optional[str] = Field(None, max_length=64)

    @field_validator("source", "sample_refs", "validation_summary", "baseline", "recipe_projection", "recipe")
    @classmethod
    def metadata_only(cls, value):
        return checked_metadata(value)


class VersionRename(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=255)


class VersionRestore(BaseModel):
    model_config = ConfigDict(extra="forbid")
    params: LutParamsModel
    context: EditingContext = Field(default_factory=EditingContext)
    unlock_conflicts: bool = False
    allow_input_change: bool = False


def version_out(record):
    snapshot = json.loads(record["snapshot_json"])
    return {**snapshot, "id": record["id"], "workspace_id": record["workspace_id"],
            "name": record["name"], "created_at": record["created_at"]}


@router.post("")
def create_workspace(body: WorkspaceCreate, user=Depends(auth.get_current_user)):
    if body.session_id is not None and not db.get_session(body.session_id, user["id"]):
        raise HTTPException(404, "会话不存在")
    existing = db.get_workspace(body.id, user["id"]) if body.id else None
    if existing:
        return existing
    try:
        return db.create_workspace(user["id"], body.id, body.session_id, body.name)
    except pymysql.err.IntegrityError as exc:
        existing = db.get_workspace(body.id,user["id"])
        if existing:
            return existing
        raise HTTPException(409,"工作区标识已使用") from exc


@router.get("")
def list_workspaces(user=Depends(auth.get_current_user)):
    return db.list_workspaces(user["id"])


@router.get("/{workspace_id}")
def get_workspace(workspace_id: str, user=Depends(auth.get_current_user)):
    return require_workspace(workspace_id, user["id"])


@router.patch("/{workspace_id}")
def update_workspace(workspace_id: str, body: WorkspaceUpdate, user=Depends(auth.get_current_user)):
    require_workspace(workspace_id, user["id"])
    if body.session_id is not None and not db.get_session(body.session_id, user["id"]):
        raise HTTPException(404, "会话不存在")
    fields = body.model_dump(exclude_unset=True)
    if fields.get("name", "") is None:
        raise HTTPException(422, "名称不能为空")
    return db.update_workspace(workspace_id, user["id"], **fields)


@router.delete("/{workspace_id}", status_code=204)
def delete_workspace(workspace_id: str, user=Depends(auth.get_current_user)):
    if not db.delete_workspace(workspace_id, user["id"]):
        raise HTTPException(404, "工作区不存在")


@router.post("/{workspace_id}/versions")
def create_version(workspace_id: str, body: VersionCreate, user=Depends(auth.get_current_user)):
    require_workspace(workspace_id, user["id"])
    snapshot = body.model_dump(exclude={"name"})
    if body.recipe:
        try:
            snapshot["recipe"] = validate_recipe(body.recipe)
        except RecipeError as exc:
            raise recipe_http_error(exc) from exc
    snapshot.update(format_version=1, engine_version=ENGINE_VERSION,
                    input_contract=input_contract(body.params.model_dump()))
    try:
        checked_metadata(snapshot)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    try:
        return version_out(db.create_workspace_version(workspace_id,user["id"],body.name,_json(snapshot)))
    except ValueError as exc:
        raise HTTPException(409, "每个工作区最多保存 20 个命名版本") from exc


@router.get("/{workspace_id}/versions")
def list_versions(workspace_id: str, user=Depends(auth.get_current_user)):
    require_workspace(workspace_id,user["id"])
    return [version_out(row) for row in db.list_workspace_versions(workspace_id,user["id"])]


@router.get("/{workspace_id}/versions/{version_id}")
def get_version(workspace_id: str, version_id: str, user=Depends(auth.get_current_user)):
    require_workspace(workspace_id,user["id"])
    record = db.get_workspace_version(workspace_id,version_id,user["id"])
    if not record:
        raise HTTPException(404,"版本不存在")
    return version_out(record)


@router.patch("/{workspace_id}/versions/{version_id}")
def rename_version(workspace_id: str, version_id: str, body: VersionRename, user=Depends(auth.get_current_user)):
    get_version(workspace_id,version_id,user)
    return version_out(db.rename_workspace_version(workspace_id,version_id,user["id"],body.name))


@router.delete("/{workspace_id}/versions/{version_id}",status_code=204)
def delete_version(workspace_id: str, version_id: str, user=Depends(auth.get_current_user)):
    require_workspace(workspace_id,user["id"])
    if not db.delete_workspace_version(workspace_id,version_id,user["id"]):
        raise HTTPException(404,"版本不存在")


@router.post("/{workspace_id}/versions/{version_id}/restore")
def restore_version(workspace_id: str, version_id: str, body: VersionRestore, user=Depends(auth.get_current_user)):
    version = get_version(workspace_id,version_id,user)
    current, target = body.params.model_dump(), version["params"]
    changes = {key:{"before":current[key],"after":value} for key,value in target.items() if current[key] != value}
    locks = sorted(set(changes) & set(body.context.locked_fields))
    input_changed = input_contract(current) != version["input_contract"]
    if (locks and not body.unlock_conflicts) or (input_changed and not body.allow_input_change):
        raise HTTPException(409,{"code":"restore_conflict","locked_fields":locks,"input_changed":input_changed})
    context = body.context.model_dump()
    context["locked_fields"] = [field for field in context["locked_fields"] if field not in locks]
    context["goal_mode"] = version["context"]["goal_mode"]
    return {"params":target,"context":context,"changes":changes,"version":version}


class ValidationSample(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1,max_length=128)
    input_contract: dict
    source_digest: Optional[str] = Field(None,max_length=128)
    origin: Literal["source","restored_preview"] = "source"
    name: Optional[str] = Field(None,max_length=255)

    @field_validator("input_contract")
    @classmethod
    def valid_input(cls,value):
        return validate_input_contract(value)


def params_digest(params):
    return hashlib.sha256(json.dumps(params,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()


def pixel_digest(pixels):
    shape = f"{pixels.shape[1]}x{pixels.shape[0]}:".encode()
    return hashlib.sha256(shape + np.ascontiguousarray(pixels,dtype="<f4").tobytes()).hexdigest()


def measure_sample(raw, sample, params, baseline_lut, current_lut):
    from photo import stats as S, render as R, quality as Q
    image = S.load_image(raw)
    baseline = R.render_lut(baseline_lut,image)
    current = R.render_lut(current_lut,image)
    mask = S.skin_mask_of(baseline)
    before, after = S.analyze(baseline,skin_mask=mask), S.analyze(current,skin_mask=mask)
    measured = S.downsample(image)
    bright_delta = after.highlight_clip_pct-before.highlight_clip_pct
    dark_delta = after.shadow_clip_pct-before.shadow_clip_pct
    skin_pixels = int(mask.sum())
    skin_available = skin_pixels >= 32 and before.skin_ratio > 0.02
    chroma, luma = Q.skin_shift(before,after) if skin_available else (None,None)
    risks = []
    if bright_delta > Q.MAX_CLIP_INCREASE_PCT:
        risks.append("高光裁剪增加")
    if dark_delta > Q.MAX_CLIP_INCREASE_PCT:
        risks.append("暗部裁剪增加")
    if chroma is not None and chroma > Q.SKIN_CHROMA_LIMIT:
        risks.append("肤色色彩偏移")
    if luma is not None and luma > Q.SKIN_LUMA_LIMIT:
        risks.append("肤色明度漂移")
    return {"id":sample.id,"status":"attention" if risks else "no_new_risk",
            "label":"待关注" if risks else "暂未发现新增风险","risks":risks,
            "source_digest":sample.source_digest,"upload_digest":hashlib.sha256(raw).hexdigest(),
            "origin":sample.origin,"input_contract":sample.input_contract,"measured_input_contract":input_contract(params),
            "preview_pixel_digest":pixel_digest(image),"measured_pixel_digest":pixel_digest(measured),
            "preview_dimensions":{"width":image.shape[1],"height":image.shape[0]},
            "measurement_dimensions":{"width":measured.shape[1],"height":measured.shape[0]},
            "sampled_pixels":after.sampled_px,"skin_pixels":skin_pixels,
            "skin_measurable":skin_available,"skin_chroma_shift":chroma,"skin_luma_shift":luma,
            "highlight_clip_delta_pct":bright_delta,"shadow_clip_delta_pct":dark_delta,
            "baseline":asdict(before),"current":asdict(after),
            "baseline_pixel_digest":pixel_digest(S.downsample(baseline)),
            "current_pixel_digest":pixel_digest(S.downsample(current))}


@router.post("/{workspace_id}/validate")
def validate_samples(workspace_id: str, request: Request, params: str = Form(...,max_length=8192),
                     samples: str = Form(...,max_length=16384), files: list[UploadFile] = File(...),
                     user=Depends(auth.get_current_user)):
    from photo import render as R
    from photo.types import PhotoError
    require_workspace(workspace_id,user["id"])
    try:
        full = LutParamsModel(**json.loads(params)).model_dump()
        manifest = json.loads(samples)
        if not isinstance(manifest,list) or not 1 <= len(manifest) <= 5 or len(files) != len(manifest):
            raise ValueError("每次需要 1–5 张图片,文件与样张清单一一对应")
        refs = [ValidationSample.model_validate(item) for item in manifest]
        if len({sample.id for sample in refs}) != len(refs):
            raise ValueError("样张标识不能重复")
    except (TypeError,ValueError) as exc:
        raise HTTPException(422,str(exc)) from exc
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BATCH_BYTES+1024*1024:
        raise HTTPException(413,"单次图片总量不能超过 64MB")
    _, retry = db.reserve_auth_event(f"validation:{user['id']}",10,60)
    if retry:
        raise HTTPException(429,"验证请求过于频繁",headers={"Retry-After":str(retry)})
    if not _validation_slots.acquire(blocking=False):
        raise HTTPException(429,"统计验证正在处理,请稍后重试",headers={"Retry-After":"2"})
    try:
        contract = input_contract(full)
        neutral = {"base_photo_style":full["base_photo_style"],"tone_map":full["tone_map"]}
        baseline_lut, current_lut = R.lut_from_params(neutral), R.lut_from_params(full)
        results, total = [], 0
        for file,sample in zip(files,refs):
            raw = file.file.read(MAX_IMAGE_BYTES+1)
            total += len(raw)
            if total > MAX_BATCH_BYTES:
                raise HTTPException(413,"单次图片总量不能超过 64MB")
            error = None
            if len(raw) > MAX_IMAGE_BYTES:
                error = "单张图片不能超过 32MB"
            elif any(sample.input_contract[key] != contract[key]
                     for key in ("base_photo_style","output_encoding")):
                error = "样张输入信号与当前基准不一致"
            if error is None:
                try:
                    results.append(measure_sample(raw,sample,full,baseline_lut,current_lut))
                except PhotoError as exc:
                    error = str(exc)
            if error:
                results.append({"id":sample.id,"status":"unmeasurable","label":"无法测量",
                                "reason":error,"source_digest":sample.source_digest,
                                "origin":sample.origin,"input_contract":sample.input_contract})
        out = {"workspace_id":workspace_id,"params_digest":params_digest(full),
               "engine_version":ENGINE_VERSION,"measurement_version":MEASUREMENT_VERSION,
               "input_contract":contract,"baseline_definition":"相同输入基准的中性参数;V-Log 保留显示转换",
               "results":results}
        out["id"] = db.add_workspace_report(workspace_id,user["id"],"validation",_json(out))
        return out
    finally:
        _validation_slots.release()


@router.get("/{workspace_id}/validation")
def latest_validation(workspace_id: str,user=Depends(auth.get_current_user)):
    require_workspace(workspace_id,user["id"])
    record = db.latest_workspace_report(workspace_id,user["id"],"validation")
    return {**json.loads(record["payload_json"]),"id":record["id"]} if record else None
