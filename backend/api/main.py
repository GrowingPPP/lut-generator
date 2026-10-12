"""LUT 管理 API。"""
import json
import logging
import os
from dataclasses import asdict
from typing import List, Literal, Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, JSONResponse
from fastapi.exceptions import RequestValidationError
from openai import APIConnectionError, APIStatusError, APITimeoutError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from api import auth, ratelimit
from api.models import LutParamsModel, checked_metadata
from api.asset_metadata import OrganizationFields, MetadataPatch
from storage.library_metadata import organization_changes, normalized_text
from fastapi import Query
from agent.editing import EditingContext
from lut_engine import RecipeError, apply_recipe, input_contract, neutral_recipe_params, validate_recipe, validate_input_contract
from lut_engine import generate_lut, lut_to_cube, lut_params_from_dict
from storage import db
from api.workspaces import router as workspace_router, require_workspace, recipe_http_error, ENGINE_VERSION, validation_slot
from api.auto_jobs import router as auto_jobs_router
from api.photos import router as photos_router
from api.imported_luts import router as imported_luts_router, resolver_for_user
from api.reference_match import router as reference_router
from photo import render as R
from lut_engine import technical_baseline_params
from lut_engine import CubeError
from contextlib import nullcontext

logger = logging.getLogger("chroma.api")


class AssetMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recipe: Optional[dict] = None
    input_contract: Optional[dict] = None
    source: Optional[dict] = None
    workspace_id: Optional[str] = Field(None, max_length=36)

    @field_validator("recipe", "input_contract", "source")
    @classmethod
    def metadata_only(cls, value):
        return checked_metadata(value)


class LutCreate(AssetMetadata, OrganizationFields):
    name: str = Field(min_length=1, max_length=255)
    description: str = Field("", max_length=4000)
    params: Optional[LutParamsModel] = None
    kind: Literal["full_snapshot", "portable_style"] = "full_snapshot"

    @field_validator("name",mode="before")
    @classmethod
    def name_valid(cls,value):
        return normalized_text(value,255)


class LutUpdate(AssetMetadata, MetadataPatch):
    revision_id: Optional[int] = Field(None,ge=1)
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=4000)
    params: Optional[LutParamsModel] = None
    kind: Optional[Literal["full_snapshot", "portable_style"]] = None


class LutOut(BaseModel):
    id: int
    name: str
    description: str
    params: LutParamsModel
    created_at: str
    kind: Literal["full_snapshot", "portable_style"] = "full_snapshot"
    recipe: Optional[dict] = None
    input_contract: Optional[dict] = None
    source: Optional[dict] = None
    workspace_id: Optional[str] = None
    revision_id: Optional[int] = None
    tags: List[str] = Field(default_factory=list)
    group: Optional[str] = None
    favorite: bool = False
    cover_id: str = "engine"
    updated_at: str = ""


class AssetApply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    params: LutParamsModel
    context: EditingContext = Field(default_factory=EditingContext)
    revision_id: Optional[int] = None
    applied_revision_ids: List[int] = Field(default_factory=list, max_length=100)
    allow_repeat: bool = False
    allow_input_change: bool = False


class AssetDownload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["camera", "software"] = "camera"
    target: Literal["current"]
    params: LutParamsModel
    revision_id: Optional[int] = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    params: Optional[LutParamsModel] = None
    history: Optional[List[str]] = Field(None, max_length=12)
    session_id: Optional[int] = None
    workspace_id: Optional[str] = Field(None,max_length=36)
    context: Optional[EditingContext] = None
    source_digest: Optional[str] = Field(None,max_length=128)
    main_sample_id: Optional[str] = Field(None,max_length=128)


class ChatResponse(BaseModel):
    reply: str = ""
    params: Optional[LutParamsModel] = None
    done: bool = False
    cube_text: Optional[str] = None
    error: Optional[str] = None
    session_id: Optional[int] = None
    workspace_id: Optional[str] = None
    source_digest: Optional[str] = None
    main_sample_id: Optional[str] = None
    goal_status: str = "not_evaluated"
    execution_status: str = "skipped"
    blocked_reasons: List[str] = Field(default_factory=list)
    observations: List[dict] = Field(default_factory=list)
    steps: List[dict] = Field(default_factory=list)


class SessionCreate(BaseModel):
    title: str = Field("新会话", min_length=1, max_length=255)


class SessionUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=255)


class SessionOut(BaseModel):
    id: int
    title: str
    created_at: str


class MessageOut(BaseModel):
    id: int
    role: str
    content: str
    params: Optional[LutParamsModel] = None
    created_at: str


class GeneratedLutOut(BaseModel):
    """会话中最近一次生成结果:参数 + cube 文本,用于重开会话后恢复与直接下载。"""

    message_id: int
    params: Optional[LutParamsModel] = None
    cube_text: str


def _record_to_out(rec: dict) -> LutOut:
    return LutOut(
        id=rec["id"],
        name=rec["name"],
        description=rec["description"],
        params=LutParamsModel(**json.loads(rec["params_json"])),
        created_at=rec["created_at"],
        kind=rec.get("kind") or "full_snapshot", workspace_id=rec.get("workspace_id"),
        revision_id=rec.get("revision_id"),
        recipe=json.loads(rec["recipe_json"]) if rec.get("recipe_json") else None,
        input_contract=json.loads(rec["input_contract_json"]) if rec.get("input_contract_json") else None,
        source=json.loads(rec["source_json"]) if rec.get("source_json") else None,
        tags=json.loads(rec["tags_json"]) if rec.get("tags_json") else [],
        group=rec.get("group_name"),favorite=bool(rec.get("favorite",False)),
        cover_id=rec.get("cover_id") or "engine",updated_at=rec.get("updated_at") or rec["created_at"],
    )


app = FastAPI(title="CHROMA LUT API")
db.init_db()
app.include_router(workspace_router)
app.include_router(auto_jobs_router)
app.include_router(photos_router)
app.include_router(imported_luts_router)
app.include_router(reference_router)


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exc):
    """错误摘要不回显非法数值或请求中的敏感内容。"""
    return JSONResponse(status_code=422,content={"detail":[
        {"type":error["type"],"loc":error["loc"],"msg":error["msg"]}
        for error in exc.errors()]})


def _secure_cookie() -> bool:
    return os.environ.get("CHROMA_ENV", "").strip().lower() in ("production", "prod")


def _safe_stem(name: str) -> str:
    """下载文件名主干:去掉路径分隔符与控制字符(含 CR/LF),避免变成路径或被用坏。"""
    cleaned = "".join(ch for ch in name if ch.isprintable() and ch not in "/\\")
    return cleaned.strip() or "lut"


def _content_disposition(stem: str, mode: str, photo_style: str = "STD") -> str:
    """构造下载头:filename* 保真 UTF-8,filename 作为老客户端兜底(纯 ASCII)。"""
    mode = "camera" if mode == "camera" else "software"  # 白名单,不信调用方
    signal = "VLOG_to_Rec709" if photo_style == "VLOG" else f"{photo_style}_sRGB"
    full = camera_file_name(stem) if mode == "camera" else f"{stem}_{signal}.cube"
    ascii_fallback = "".join(ch if ch.isascii() and ch.isprintable() and ch not in '\\"' else "_" for ch in full)
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(full)}"


def camera_file_name(name: str) -> str:
    """松下 FAT32 导入可用的 8 位 ASCII 文件主名。"""
    h = 0x811c9dc5
    for byte in name.encode("utf-8"):
        h = ((h ^ byte) * 0x01000193) & 0xffffffff
    return f"{h:08X}.cube"


def _asset_content(body, existing=None):
    values = body.model_dump(exclude_unset=True)
    if existing:
        for field in ("params","kind"):
            if values.get(field) is None:
                values.pop(field,None)
    current = _record_to_out(existing).model_dump() if existing else {}
    current.update(values)
    kind = current.get("kind") or "full_snapshot"
    recipe = current.get("recipe")
    try:
        if recipe is not None:
            recipe = validate_recipe(recipe)
        if kind == "portable_style":
            if recipe is None:
                raise RecipeError("missing_recipe", "可复用风格必须提供配方")
            params = neutral_recipe_params(recipe)
            contract = recipe["input_contract"]
        else:
            raw_params = current.get("params")
            if raw_params is None:
                raise RecipeError("missing_params", "完整效果必须提供参数")
            params = LutParamsModel(**raw_params).model_dump()
            contract = input_contract(params)
        supplied_contract = values.get("input_contract") if {"params","recipe","kind"} & set(values) else current.get("input_contract")
        if supplied_contract is not None and validate_input_contract(supplied_contract) != contract:
            raise RecipeError("input_conflict", "资产声明与实际输入契约不一致")
        if recipe and recipe["input_contract"] != contract:
            raise RecipeError("input_conflict", "配方与资产输入契约不一致")
    except RecipeError as exc:
        raise recipe_http_error(exc) from exc
    encode = lambda value: json.dumps(value,ensure_ascii=False,allow_nan=False) if value is not None else None
    return json.dumps(params,allow_nan=False), {
        "kind":kind,"recipe_json":encode(recipe),"input_contract_json":encode(contract),
        "source_json":encode(current.get("source")),"workspace_id":current.get("workspace_id")}


def _validate_external(params, user_id):
    if not params.get("external_lut_id"):
        return
    try:
        R.lut_from_params(params, resolver=resolver_for_user(user_id))
    except CubeError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/luts", response_model=LutOut)
def create_lut(body: LutCreate, user: dict = Depends(auth.get_current_user)):
    if body.workspace_id:
        require_workspace(body.workspace_id,user["id"])
    params_json,metadata = _asset_content(body)
    _validate_external(json.loads(params_json), user["id"])
    metadata.update(organization_changes(body.model_dump(exclude_unset=True)))
    lut_id = db.create_lut(user["id"],body.name,body.description,params_json,**metadata)
    return _record_to_out(db.get_lut(lut_id,user["id"]))


@app.get("/api/luts", response_model=List[LutOut])
def list_luts(q: Optional[str]=Query(None,max_length=200),
              kind: Optional[Literal["full_snapshot","portable_style"]]=None,
              input: Optional[Literal["STD","NAT","VIVD","VLOG"]]=None,
              favorite: Optional[bool]=None,group: Optional[str]=Query(None,max_length=48),
              sort: Literal["created_desc","created_asc","updated_desc","updated_asc","name_asc","name_desc"]="created_desc",
              user: dict=Depends(auth.get_current_user)):
    try:
        records = db.list_luts(user["id"],q=q,kind=kind,input_style=input,
                              favorite=favorite,group=group,sort=sort)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    return [_record_to_out(r) for r in records]


@app.get("/api/luts/summary")
def library_summary(user: dict=Depends(auth.get_current_user)):
    return db.library_summary(user["id"])


@app.get("/api/luts/{lut_id}", response_model=LutOut)
def get_lut(lut_id: int, user: dict = Depends(auth.get_current_user)):
    rec = db.get_lut(lut_id, user["id"])
    if not rec:
        raise HTTPException(status_code=404, detail="LUT not found")
    return _record_to_out(rec)


@app.put("/api/luts/{lut_id}", response_model=LutOut)
def update_lut(lut_id: int,body: LutUpdate,user: dict=Depends(auth.get_current_user)):
    if body.workspace_id:
        require_workspace(body.workspace_id,user["id"])
    organization = organization_changes(body.model_dump(exclude_unset=True))
    content_fields = {"params","kind","recipe","input_contract","source","workspace_id"}
    supplied = body.model_dump(exclude_unset=True)
    for key in ("params","kind"):
        if supplied.get(key) is None:
            supplied.pop(key,None)
    def content(locked):
        params_json,metadata = _asset_content(body,locked)
        _validate_external(json.loads(params_json), user["id"])
        return params_json,{**metadata,**organization}
    try:
        rec = db.update_lut(lut_id,user["id"],name=body.name,description=body.description,
                            build_content=content if content_fields & set(supplied) else None,
                            expected_revision_id=body.revision_id,**organization)
    except db.RevisionConflictError as exc:
        raise HTTPException(409,{"code":"revision_conflict","message":str(exc),
                                 "current_revision_id":exc.current_revision_id}) from exc
    if not rec:
        raise HTTPException(404,"LUT not found")
    return _record_to_out(rec)


@app.patch("/api/luts/{lut_id}/metadata",response_model=LutOut)
def update_asset_metadata(lut_id: int,body: MetadataPatch,user: dict=Depends(auth.get_current_user)):
    values = body.model_dump(exclude_unset=True)
    try:
        rec = db.update_lut(lut_id,user["id"],name=values.get("name"),description=values.get("description"),
                            expected_revision_id=values.get("revision_id"),**organization_changes(values))
    except db.RevisionConflictError as exc:
        raise HTTPException(409,{"code":"revision_conflict","message":str(exc),
                                 "current_revision_id":exc.current_revision_id}) from exc
    if not rec:
        raise HTTPException(404,"LUT not found")
    return _record_to_out(rec)


@app.delete("/api/luts/{lut_id}", status_code=204)
def delete_lut(lut_id: int, user: dict = Depends(auth.get_current_user)):
    if not db.delete_lut(lut_id, user["id"]):
        raise HTTPException(status_code=404, detail="LUT not found")


def _selected_asset(lut_id,user_id,revision_id=None):
    if revision_id is not None:
        revision = db.get_lut_revision(lut_id,revision_id,user_id)
        if not revision:
            raise HTTPException(404,"资产修订不存在")
        return {**json.loads(revision["snapshot_json"]),"revision_id":revision_id,"id":lut_id}
    record = db.get_lut(lut_id,user_id)
    if not record:
        raise HTTPException(404,"LUT not found")
    return _record_to_out(record).model_dump()


@app.get("/api/luts/{lut_id}/revisions")
def asset_revisions(lut_id: int,user: dict=Depends(auth.get_current_user)):
    if not db.get_lut(lut_id,user["id"]):
        raise HTTPException(404,"LUT not found")
    return [{"id":row["id"],"revision_id":row["id"],"revision_number":row["revision_number"],
             "created_at":row["created_at"],**json.loads(row["snapshot_json"])}
            for row in db.list_lut_revisions(lut_id,user["id"])]


@app.post("/api/luts/{lut_id}/apply")
def apply_asset(lut_id: int,body: AssetApply,user: dict=Depends(auth.get_current_user)):
    asset = _selected_asset(lut_id,user["id"],body.revision_id)
    revision_id = asset.get("revision_id")
    if asset["kind"] == "portable_style" and revision_id in body.applied_revision_ids and not body.allow_repeat:
        raise HTTPException(409,{"code":"repeat_application","message":"此修订已应用,请确认是否再次叠加"})
    current = body.params.model_dump()
    try:
        if asset["kind"] == "portable_style":
            candidate,changes = apply_recipe(asset["recipe"],current,body.context.locked_fields)
        else:
            candidate = LutParamsModel(**asset["params"]).model_dump()
            changes = {key:{"before":current[key],"after":value}
                       for key,value in candidate.items() if current[key] != value}
            conflicts = set(changes) & set(body.context.locked_fields)
            if conflicts:
                raise RecipeError("lock_conflict","完整效果会修改受保护参数",conflicts)
            if input_contract(current) != input_contract(candidate) and not body.allow_input_change:
                raise RecipeError("input_conflict","载入完整效果需要确认输入切换")
    except RecipeError as exc:
        raise recipe_http_error(exc) from exc
    _validate_external(current, user["id"])
    _validate_external(candidate, user["id"])
    return {"params":candidate,"changes":changes,"kind":asset["kind"],"recipe":asset.get("recipe"),
            "revision_id":revision_id,"source":asset.get("source"),"validation_status":"not_verified"}


@app.post("/api/luts/{lut_id}/apply-validated")
def apply_asset_with_image(lut_id: int,request: Request,body: str=Form(...,max_length=32768),
                           file: UploadFile=File(...),user: dict=Depends(auth.get_current_user)):
    """有主样张时,对候选沿用确定性图像风险检查,图片不留存。"""
    from agent.auto import check_hard_rules
    from photo import stats as S,render as R,quality as Q
    from photo.types import PhotoError,ImageTooLargeError
    try:
        parsed = AssetApply.model_validate(json.loads(body))
    except (ValueError,TypeError) as exc:
        raise HTTPException(422,str(exc)) from exc
    out = apply_asset(lut_id,parsed,user)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_AUTO_IMAGE_BYTES+1024*1024:
        raise HTTPException(413,"图片不能超过 32MB")
    raw = file.file.read(MAX_AUTO_IMAGE_BYTES+1)
    if len(raw) > MAX_AUTO_IMAGE_BYTES:
        raise HTTPException(413,"图片不能超过 32MB")
    _,retry = db.reserve_auth_event(f"validation:{user['id']}",10,60)
    if retry:
        raise HTTPException(429,"验证请求过于频繁",headers={"Retry-After":str(retry)})
    with validation_slot(), R.using_lut_resolver(resolver_for_user(user["id"])):
        try:
            image = S.load_image(raw, parsed.params.base_photo_style)
        except ImageTooLargeError as exc:
            raise HTTPException(413,str(exc)) from exc
        except PhotoError as exc:
            raise HTTPException(400,str(exc)) from exc
        current = parsed.params.model_dump()
        neutral = technical_baseline_params(current)
        baseline_image = R.render_lut(R.lut_from_params(neutral),image)
        mask = S.skin_mask_of(baseline_image)
        baseline = S.analyze(baseline_image,skin_mask=mask)
        before = S.analyze(R.render_lut(R.lut_from_params(current),image),skin_mask=mask)
        allowed,reasons = check_hard_rules(before,out["params"],baseline,Q.limits_for(before),current,image,mask,parsed.context)
        if not allowed:
            raise HTTPException(409,{"code":"image_risk","message":"图像风险检查未通过,候选未应用","reasons":reasons})
        out["validation_status"] = "measured"
        out["validation"] = {"engine_version":ENGINE_VERSION,"input_contract":input_contract(current),
                             "preview_dimensions":{"width":image.shape[1],"height":image.shape[0]},
                             "sampled_pixels":before.sampled_px}
        return out


def _cube_response(asset,params,mode,user_id):
    engine_params = lut_params_from_dict(params)
    try:
        lut = R.lut_from_params(params, resolver=resolver_for_user(user_id))
    except CubeError as exc:
        raise HTTPException(422, str(exc)) from exc
    photo_style = engine_params.base_photo_style if mode == "camera" else None
    input_signal = "VLOG/V-Gamut" if engine_params.base_photo_style == "VLOG" else f"{engine_params.base_photo_style}/sRGB"
    output_signal = "Rec709" if engine_params.base_photo_style == "VLOG" else "sRGB"
    title = asset["name"] if mode == "camera" else f"{asset['name']} [{input_signal} -> {output_signal}]"
    text = lut_to_cube(lut,title=title,photo_style=photo_style)
    return Response(content=text,media_type="text/plain; charset=utf-8",headers={
        "Content-Disposition":_content_disposition(_safe_stem(asset["name"]),mode,engine_params.base_photo_style)})


@app.get("/api/luts/{lut_id}/download")
def download_lut(lut_id: int,mode: Literal["camera","software"]="camera",
                 target: Optional[Literal["neutral","saved"]]=None,revision_id: Optional[int]=None,
                 user: dict=Depends(auth.get_current_user)):
    asset = _selected_asset(lut_id,user["id"],revision_id)
    if asset["kind"] == "portable_style":
        if target != "neutral":
            raise HTTPException(422,"可复用风格下载必须明确选择 neutral,或提交 current 完整参数")
        try:
            params = neutral_recipe_params(asset["recipe"])
        except RecipeError as exc:
            raise recipe_http_error(exc) from exc
    else:
        if target == "neutral":
            raise HTTPException(422,"完整效果只能下载已保存参数或 current 完整参数")
        params = asset["params"]
    return _cube_response(asset,params,mode,user["id"])


@app.post("/api/luts/{lut_id}/download")
def download_current_lut(lut_id: int,body: AssetDownload,user: dict=Depends(auth.get_current_user)):
    asset = _selected_asset(lut_id,user["id"],body.revision_id)
    params = body.params.model_dump()
    if input_contract(params) != (asset.get("input_contract") or input_contract(asset["params"])):
        raise HTTPException(409,{"code":"input_conflict","message":"当前完整参数与资产输入契约不一致"})
    return _cube_response(asset,params,body.mode,user["id"])


def _build_extract_fn(body: "ChatRequest", full_params: dict | None):
    """构造「消息 → 结构化参数」的提取函数。

    设置 CHROMA_FAKE_LLM=confirm 时用一个固定返回 confirm 的桩替代真实 LLM:
    端到端跑通「生成 → 落库 → 重开会话恢复」链路,不消耗真实 API 配额。
    """
    if os.environ.get("CHROMA_FAKE_LLM", "").strip().lower() == "confirm":
        return lambda msg: {"intent": "confirm"}

    from agent.llm import get_llm, extract_result

    client = get_llm()
    return lambda msg: extract_result(client,msg,params=full_params,history=body.history,context=body.context)


@app.post("/api/session/chat", response_model=ChatResponse)
def chat(body: ChatRequest, user: dict = Depends(auth.get_current_user)):
    """会话生成:LLM 从描述提取参数,参数齐全则生成 LUT。"""
    from agent.graph import run_agent
    from agent.llm import BudgetExhaustedError

    session_id = body.session_id
    if body.workspace_id:
        workspace = require_workspace(body.workspace_id,user["id"])
        if session_id is not None:
            if not db.get_session(session_id,user["id"]):
                raise HTTPException(404,"会话不存在")
            if workspace["session_id"] not in (None,session_id):
                raise HTTPException(409,"工作区与会话关联不一致")
            db.update_workspace(body.workspace_id,user["id"],session_id=session_id)
        else:
            session_id = db.workspace_session(body.workspace_id,user["id"])
    elif session_id is None:
        session_id = db.create_session(user["id"],"新会话")
    elif not db.get_session(session_id,user["id"]):
        raise HTTPException(404,"会话不存在")

    full_params = body.params.model_dump() if body.params else None
    if full_params:
        _validate_external(full_params,user["id"])
    initial = None
    if full_params:
        # 过滤默认值字段,只保留用户实际调整过的,避免默认值被当成已确认参数
        defaults = LutParamsModel().model_dump()
        initial = {k: v for k, v in full_params.items() if v != defaults.get(k)}
    reply = None
    params_out = None
    error = None
    done = False
    cube_text = None
    result = {}
    try:
        kwargs = {"context":body.context} if body.context is not None else {}
        with R.using_lut_resolver(resolver_for_user(user["id"])):
            result = run_agent(_build_extract_fn(body,full_params),body.message,
                               params=full_params if (body.context is not None or body.workspace_id) else initial,**kwargs)
        reply = result.get("reply", "")
        done = result.get("done", False)
        cube_text = result.get("cube_text")
        if result.get("params"):
            clamped = lut_params_from_dict(result["params"])
            d = asdict(clamped)
            for k in ("lift", "gamma", "gain"):
                d[k] = list(d[k])
            params_out = LutParamsModel(**d)
    except BudgetExhaustedError as e:
        reply = "这次没能解析出结果,请再说一次或换种说法。"
        error = str(e)
    except Exception:
        logger.exception("session/chat 生成失败")
        reply = "生成服务暂时不可用,请稍后重试"
        error = "generation_failed"

    out = ChatResponse(reply=reply,params=params_out,done=done,cube_text=cube_text,error=error,
                       session_id=session_id,workspace_id=body.workspace_id,
                       source_digest=body.source_digest,main_sample_id=body.main_sample_id,
                       goal_status=result.get("goal_status","not_evaluated"),
                       execution_status=result.get("execution_status","failed" if error else "skipped"),
                       blocked_reasons=result.get("blocked_reasons",[]),
                       observations=result.get("observations",[]),steps=result.get("steps",[]))
    db.add_message(user["id"],session_id,"user",body.message,None)
    db.add_message(user["id"],session_id,"agent",reply,
                   params_out.model_dump_json() if params_out else None,cube_text,
                   out.model_dump_json() if body.workspace_id else None)
    if body.workspace_id:
        db.add_workspace_report(body.workspace_id,user["id"],"chat",out.model_dump_json())
    return out



@app.post("/api/sessions", response_model=SessionOut)
def create_session(body: SessionCreate, user: dict = Depends(auth.get_current_user)):
    sid = db.create_session(user["id"], body.title)
    rec = db.get_session(sid, user["id"])
    return SessionOut(id=rec["id"], title=rec["title"], created_at=rec["created_at"])


@app.get("/api/sessions", response_model=List[SessionOut])
def list_sessions(user: dict = Depends(auth.get_current_user)):
    return [SessionOut(id=r["id"], title=r["title"], created_at=r["created_at"]) for r in db.list_sessions(user["id"])]


@app.delete("/api/sessions/{session_id}", status_code=204)
def delete_session(session_id: int, delete_workspace_versions: bool=False, user: dict=Depends(auth.get_current_user)):
    if not db.delete_session(session_id,user["id"],delete_workspace_versions=delete_workspace_versions):
        raise HTTPException(status_code=404, detail="会话不存在")


@app.put("/api/sessions/{session_id}", response_model=SessionOut)
def update_session(session_id: int, body: SessionUpdate, user: dict = Depends(auth.get_current_user)):
    if not db.get_session(session_id, user["id"]):
        raise HTTPException(status_code=404, detail="会话不存在")
    rec = db.update_session(session_id, user["id"], body.title)
    return SessionOut(id=rec["id"], title=rec["title"], created_at=rec["created_at"])


@app.get("/api/sessions/{session_id}/messages", response_model=List[MessageOut])
def list_messages(session_id: int, user: dict = Depends(auth.get_current_user)):
    session = db.get_session(session_id, user["id"])
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    out = []
    for m in db.list_messages(session_id, user["id"]):
        params = LutParamsModel(**json.loads(m["params_json"])) if m["params_json"] else None
        out.append(MessageOut(id=m["id"], role=m["role"], content=m["content"], params=params, created_at=m["created_at"]))
    return out


@app.get("/api/sessions/{session_id}/generated", response_model=GeneratedLutOut)
def get_generated_lut(session_id: int, user: dict = Depends(auth.get_current_user)):
    """该会话最近一次生成的 LUT(含 cube 文本)。重开会话时恢复参数、无需再让 LLM 重新生成。"""
    if not db.get_session(session_id, user["id"]):
        raise HTTPException(status_code=404, detail="会话不存在")
    rec = db.get_latest_generated_message(session_id, user["id"])
    if not rec:
        raise HTTPException(status_code=404, detail="该会话还没有生成过 LUT")
    params = LutParamsModel(**json.loads(rec["params_json"])) if rec["params_json"] else None
    return GeneratedLutOut(message_id=rec["id"], params=params, cube_text=rec["cube_text"])


class AutoGradeStepOut(BaseModel):
    stage: str
    round: int
    diagnosis: str = ""
    proposed: dict = Field(default_factory=dict)
    applied: bool = False
    rejections: List[str] = Field(default_factory=list)
    params_before: dict = Field(default_factory=dict)
    params_after: dict = Field(default_factory=dict)
    purpose: Literal["correction","style"] = "correction"
    stats_after: Optional[dict] = None


class AutoGradeIssueOut(BaseModel):
    code: str
    severity: float
    evidence: str


class AutoGradeOut(BaseModel):
    params: LutParamsModel
    job_id: Optional[str] = None
    job_fingerprint: Optional[str] = None
    before_params: Optional[LutParamsModel] = None
    session_id: Optional[int] = None
    issues: List[AutoGradeIssueOut] = Field(default_factory=list)
    steps: List[AutoGradeStepOut] = Field(default_factory=list)
    style_params: Optional[dict] = None          # 风格提议(可能未被应用)
    style_applied: bool = False                  # 提议是否真的生效
    style_applied_params: Optional[dict] = None  # 真正生效的部分
    style_rejections: List[str] = Field(default_factory=list)
    review: Optional[str] = None
    # 视觉复核未完成原因包括未变化、无有效内容、关闭及调用失败。
    review_skip_reason: Optional[str] = None
    subject_protection: dict = Field(default_factory=dict)
    degraded: bool = False
    usage: dict = Field(default_factory=dict)
    workspace_id: Optional[str] = None
    source_digest: Optional[str] = None
    main_sample_id: Optional[str] = None
    context: Optional[EditingContext] = None
    engine_version: str = ENGINE_VERSION
    goal_status: str = "not_evaluated"
    execution_status: str = "skipped"
    blocked_reasons: List[str] = Field(default_factory=list)
    observations: List[AutoGradeIssueOut] = Field(default_factory=list)
    continued_from: Optional[str] = None


class AutoGradeReportOut(AutoGradeOut):
    """报告查询的响应:比生成时的输出多一个 session_id,
    前端据此判断「这份报告是不是属于我正打开的会话」。"""
    session_id: Optional[int] = None


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    password: str = Field(min_length=8, max_length=72)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class AuthResponse(BaseModel):
    user_id: int
    username: str


MAX_AUTO_IMAGE_BYTES = 32 * 1024 * 1024      # 与模型 API 的单图上限对齐


@app.post("/api/auto/grade", response_model=AutoGradeOut)
def auto_grade_endpoint(
    request: Request,
    file: UploadFile = File(...),
    base_params: str = Form(..., max_length=8192),
    style: Optional[str] = Form(None),
    use_vision: bool = Form(True),
    max_rounds: int = Form(2),
    workspace_id: Optional[str] = Form(None,max_length=36),
    context: Optional[str] = Form(None,max_length=8192),
    source_digest: Optional[str] = Form(None,max_length=128),
    main_sample_id: Optional[str] = Form(None,max_length=128),
    sample_origin: Literal["source","restored_preview"] = Form("source"),
    user: dict = Depends(auth.get_current_user),
):
    """AI 自动修图。

    `base_params` **必填且不接受默认值**:增量语义下「用默认值兜底」会把用户手调静默抹掉。
    """
    img, parsed, ctx = _prepare_auto_grade(request, file, base_params, context,
                                           workspace_id, sample_origin, user)
    _reserve_auto_grade(user["id"])
    out = _compute_auto_grade(img, parsed, ctx, style, use_vision, max_rounds,
                              workspace_id, source_digest, main_sample_id, user_id=user["id"])
    try:
        out.session_id = _persist_auto_grade(user["id"], out)
    except Exception as exc:
        logger.exception("auto/grade 结果保存失败")
        raise HTTPException(status_code=503, detail="修图结果保存失败,请稍后重试") from exc
    return out


def _prepare_auto_grade(request, file, base_params, context, workspace_id, sample_origin, user,
                        *, include_digest=False):
    from photo import stats as photo_stats
    from photo.types import ImageTooLargeError, PhotoError

    # 1) 参数解析(base_params 非法直接 422)
    try:
        parsed = LutParamsModel(**json.loads(base_params))
        ctx = EditingContext.model_validate(json.loads(context)) if context else None
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"base_params 非法:{exc}")

    _validate_external(parsed.model_dump(),user["id"])
    if workspace_id:
        require_workspace(workspace_id,user["id"])
    if sample_origin != "source":
        raise HTTPException(422,"自动修图需要重新选择来源文件,恢复预览仅用于统计验证")

    # 2) 读图与校验
    # Content-Length 包含 multipart 边界与其他字段，允许 1 MiB 封装开销。
    # 实际图片字节仍按 MAX_AUTO_IMAGE_BYTES + 1 有界读取和精确判断。
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_AUTO_IMAGE_BYTES + 1024 * 1024:
        raise HTTPException(status_code=413, detail="图片过大,请压缩到 32MB 以内")

    raw = file.file.read(MAX_AUTO_IMAGE_BYTES + 1)
    if len(raw) > MAX_AUTO_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图片过大,请压缩到 32MB 以内")
    try:
        img = photo_stats.load_image(raw, parsed.base_photo_style)
    except ImageTooLargeError as exc:
        # 像素数超限也是「太大」,应是 413 而不是 400
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except PhotoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if include_digest:
        import hashlib
        return img, parsed, ctx, hashlib.sha256(raw).hexdigest()
    return img, parsed, ctx


def _reserve_auto_grade(user_id):
    retry = db.reserve_auto_grade_call(user_id, ratelimit.AUTO_MAX_PER_WINDOW,
                                       ratelimit.AUTO_WINDOW_SECONDS)
    if retry:
        raise HTTPException(
            status_code=429,
            detail=f"自动修图次数已达上限,请在 {max(1, retry // 60)} 分钟后重试",
            headers={"Retry-After": str(retry)},
        )


def _compute_auto_grade(img, parsed, ctx, style, use_vision, max_rounds,
                        workspace_id, source_digest, main_sample_id,
                        *, progress=None, cancel_check=None, resume=None, continued_from=None, user_id=None):
    from agent.auto import AutoGradeCancelled, auto_grade as run_auto_grade
    from agent.llm import BudgetExhaustedError

    style_text = (style or "").strip()[:200] or None
    client = None
    style_extractor = None
    if os.environ.get("CHROMA_FAKE_GRADE", "").strip():
        pass                                   # 测试桩:完全不调用 LLM
    else:
        from agent.llm import extract_result, get_llm
        client = get_llm()

        def style_extractor(_client, text, current_params):     # noqa: ANN001
            # 风格复用现有抽取路径 —— 不另立一套参数字典
            return extract_result(_client,text,params=current_params,context=ctx)

    try:
        with R.using_lut_resolver(resolver_for_user(user_id)) if user_id is not None else nullcontext():
            result = run_auto_grade(
                img,
                parsed.model_dump(),
                style=style_text,
                client=client,
                use_vision=use_vision and client is not None,
                max_rounds=max(1, min(3, int(max_rounds))),
                style_extractor=style_extractor,
                **({"context":ctx} if ctx is not None else {}),
                **({"progress": progress} if progress is not None else {}),
                **({"cancel_check": cancel_check} if cancel_check is not None else {}),
                **({"resume": resume} if resume is not None else {}),
            )
    except AutoGradeCancelled:
        raise
    except BudgetExhaustedError as exc:
        # 可操作提示:这不是「服务挂了」,而是预算配置需要调整
        logger.warning("auto/grade 预算耗尽: %s", exc)
        raise HTTPException(
            status_code=502,
            detail="模型思考预算不足,未能完成分析。请联系管理员调大 CHROMA_LLM_MAX_TOKENS",
        ) from exc
    except (APITimeoutError, APIConnectionError) as exc:
        logger.warning("auto/grade 上游不可达: %s", exc)
        raise HTTPException(status_code=504, detail="分析服务响应超时,请重试") from exc
    except APIStatusError as exc:
        # 保留上游状态码便于排查;不回传上游报文,避免泄露内部细节
        logger.warning("auto/grade 上游返回错误: status=%s", getattr(exc, "status_code", "?"))
        raise HTTPException(
            status_code=502,
            detail=f"分析服务返回错误(上游状态码 {getattr(exc, 'status_code', '未知')})",
        ) from exc
    except Exception as exc:
        logger.exception("auto/grade 未预期失败")
        raise HTTPException(status_code=502, detail="分析服务暂时不可用,请稍后重试") from exc

    out = AutoGradeOut(
        params=LutParamsModel(**{k: v for k, v in result.params.items()
                                 if k in LutParamsModel.model_fields}),
        before_params=parsed,
        issues=[AutoGradeIssueOut(code=i.code, severity=i.severity, evidence=i.evidence)
                for i in result.issues],
        steps=[AutoGradeStepOut(stage=st.stage, round=st.round, diagnosis=st.diagnosis,
                                proposed=st.proposed, applied=st.applied,
                                rejections=st.rejections,
                                params_before=st.params_before,params_after=st.params_after,purpose=st.purpose,
                                stats_after=asdict(st.stats_after) if st.stats_after else None)
               for st in result.steps],
        style_params=result.style_params,
        style_applied=result.style_applied,
        style_applied_params=result.style_applied_params,
        style_rejections=result.style_rejections,
        review=result.review,
        review_skip_reason=result.review_skip_reason,
        subject_protection=result.subject_protection,
        degraded=result.degraded,
        usage=result.usage,workspace_id=workspace_id,source_digest=source_digest,
        main_sample_id=main_sample_id,context=ctx,
        goal_status=result.goal_status,execution_status=result.execution_status,
        blocked_reasons=result.blocked_reasons,
        observations=[AutoGradeIssueOut(code=i.code,severity=i.severity,evidence=i.evidence)
                      for i in result.observations],
        continued_from=continued_from,
    )
    return out


def _persist_auto_grade(user_id: int, out: AutoGradeOut) -> int:
    """按工作区关联保存报告;旧客户端仍使用原有自动会话。"""
    goal_labels = {"met": "已满足本次可测目标", "partially_met": "目标部分完成",
                   "unchanged": "保留原参数", "not_evaluated": "尚未评估"}
    execution_labels = {"model": "模型执行", "rules_only": "仅规则调整",
                        "skipped": "已跳过", "failed": "执行失败"}
    lines = ["AI 自动修图：目标状态：" + goal_labels.get(out.goal_status, out.goal_status)
             + "；执行：" + execution_labels.get(out.execution_status, out.execution_status)]
    for st in out.steps:
        mark = "已应用" if st.applied else "被拦下"
        lines.append(f"  [{st.stage}] {st.diagnosis}({mark})")
    for reason in out.blocked_reasons:
        lines.append(f"  限制：{reason}")
    if out.degraded and out.execution_status in ("model", "rules_only"):
        lines.append("  仍有目标冲突，请结合报告判断当前效果")
    if out.review:
        lines.append(f"  视觉复核:{out.review}")
    elif out.review_skip_reason:
        lines.append(f"  视觉复核未执行({out.review_skip_reason})")
    sid = db.persist_auto_grade(user_id, out.workspace_id, "\n".join(lines),
                                out.params.model_dump_json(), out.model_dump())
    out.session_id = sid
    return sid


@app.get("/api/auto/report", response_model=Optional[AutoGradeReportOut])
def get_auto_report(workspace_id: Optional[str]=None,user: dict=Depends(auth.get_current_user)):
    """取该用户最近一次自动修图结果,供前端刷新后重建报告。

    返回带 session_id:前端据此判断该不该在当前打开的会话里展示 ——
    否则在别的会话里也会弹出上一份报告。

    没有记录时返回 null(而不是 404)—— 「还没修过图」是正常状态,不是错误。
    """
    if workspace_id:
        workspace = require_workspace(workspace_id,user["id"])
        sid = workspace["session_id"]
        rec = db.latest_workspace_report(workspace_id,user["id"],"auto")
    else:
        sid = db.find_auto_session(user["id"])
        if sid is None:
            return None
        rec = db.get_latest_payload_message(sid,user["id"])
    if not rec or not rec["payload_json"]:
        return None
    try:
        payload = json.loads(rec["payload_json"])
        if payload.get("undone"):
            return None
        payload["session_id"] = sid
        return AutoGradeReportOut(**payload)
    except (json.JSONDecodeError, TypeError, ValueError):
        # 历史数据格式不符(例如旧版本写入的)不应报错,当作没有
        return None


@app.post("/api/auto/undo")
def undo_auto_grade(workspace_id: Optional[str]=None,user: dict=Depends(auth.get_current_user)):
    if workspace_id:
        workspace = require_workspace(workspace_id,user["id"])
        sid = workspace["session_id"]
        rec = db.latest_workspace_report(workspace_id,user["id"],"auto")
    else:
        sid = db.find_auto_session(user["id"])
        rec = db.get_latest_payload_message(sid,user["id"]) if sid is not None else None
    if not rec:
        raise HTTPException(status_code=404, detail="没有可撤销的修图")
    try:
        payload = json.loads(rec["payload_json"])
        before = LutParamsModel(**payload["before_params"])
        if payload.get("undone"):
            raise ValueError("already undone")
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=404, detail="没有可撤销的修图")
    if workspace_id and sid is None:
        sid = db.workspace_session(workspace_id,user["id"])
    db.add_message(user["id"],sid,"agent","已撤销自动修图",before.model_dump_json(),
                   None, json.dumps({"undone": True}))
    if workspace_id:
        db.add_workspace_report(workspace_id,user["id"],"auto",json.dumps({"undone":True}))
    return {"params":before}


@app.post("/api/auth/register", response_model=AuthResponse)
def register(body: RegisterRequest, request: Request, response: Response):
    ip = request.client.host if request.client else "unknown"
    if ratelimit.is_blocked(ip):
        raise HTTPException(status_code=429, detail="尝试次数过多,请稍后再试")
    _, retry = db.reserve_auth_event(f"register:{ip}", 5, 300)
    if retry:
        raise HTTPException(status_code=429, detail="注册次数过多,请稍后再试",
                            headers={"Retry-After": str(retry)})
    if db.get_user_by_username(body.username):
        raise HTTPException(status_code=409, detail="用户名已存在")
    user_id = db.create_user(body.username, auth.hash_password(body.password))
    token = auth.create_token(user_id, 0)
    response.set_cookie(key="chroma_token", value=token, httponly=True, samesite="lax", secure=_secure_cookie(), max_age=86400, path="/")
    return AuthResponse(user_id=user_id, username=body.username)


@app.post("/api/auth/login", response_model=AuthResponse)
def login(body: LoginRequest, request: Request, response: Response):
    ip = request.client.host if request.client else "unknown"
    if ratelimit.is_blocked(ip):
        raise HTTPException(status_code=429, detail="尝试次数过多,请稍后再试")
    event_id, retry = db.reserve_auth_event(f"login:{ip}", 5, 300)
    if retry:
        raise HTTPException(status_code=429, detail="尝试次数过多,请稍后再试",
                            headers={"Retry-After": str(retry)})
    user = db.get_user_by_username(body.username)
    if not user:
        ratelimit.record_failure(ip)
        auth.verify_password(body.password, auth.DUMMY_HASH)  # 抹平时序防用户名枚举
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not auth.verify_password(body.password, user["password_hash"]):
        ratelimit.record_failure(ip)
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    db.release_auth_event(event_id)
    ratelimit.reset(ip)
    token = auth.create_token(user["id"], user.get("token_version", 0))
    response.set_cookie(key="chroma_token", value=token, httponly=True, samesite="lax", secure=_secure_cookie(), max_age=86400, path="/")
    return AuthResponse(user_id=user["id"], username=user["username"])


@app.post("/api/auth/logout", status_code=204)
def logout(response: Response, user: dict = Depends(auth.get_current_user)):
    db.bump_token_version(user["id"])
    response.delete_cookie(key="chroma_token", path="/")


@app.get("/api/auth/me")
def me(user: dict = Depends(auth.get_current_user)):
    return {"user_id": user["id"], "username": user["username"]}
