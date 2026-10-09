"""LUT 管理 API。"""
import json
import logging
import os
from dataclasses import asdict
from typing import List, Literal, Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from openai import APIConnectionError, APIStatusError, APITimeoutError
from pydantic import BaseModel, Field

from api import auth, ratelimit
from lut_engine import generate_lut, lut_to_cube, lut_params_from_dict
from storage import db

logger = logging.getLogger("chroma.api")


class LutParamsModel(BaseModel):
    base_photo_style: Literal["STD", "NAT", "VIVD", "VLOG"] = "STD"
    temp: float = Field(0.0, ge=-3000, le=3000)
    tint: float = Field(0.0, ge=-500, le=500)
    exposure: float = Field(0.0, ge=-3, le=3)
    contrast: float = Field(0.0, ge=-1, le=1)
    saturation: float = Field(0.0, ge=-1, le=1)
    hue: float = Field(0.0, ge=-180, le=180)
    vibrance: float = Field(0.0, ge=-1, le=1)
    tone_map: float = Field(1.0, ge=0, le=1)
    # 影调分区(逐点,可烘进 33³ LUT)
    highlights: float = Field(0.0, ge=-1, le=1)
    shadows: float = Field(0.0, ge=-1, le=1)
    whites: float = Field(0.0, ge=-1, le=1)
    blacks: float = Field(0.0, ge=-1, le=1)
    curve: float = Field(0.0, ge=-1, le=1)
    # 分离色调
    split_shadow_hue: float = Field(0.0, ge=0, le=360)
    split_shadow_sat: float = Field(0.0, ge=0, le=1)
    split_highlight_hue: float = Field(0.0, ge=0, le=360)
    split_highlight_sat: float = Field(0.0, ge=0, le=1)
    split_balance: float = Field(0.5, ge=0, le=1)
    lift: List[float] = Field([0.0, 0.0, 0.0], min_length=3, max_length=3)
    gamma: List[float] = Field([1.0, 1.0, 1.0], min_length=3, max_length=3)
    gain: List[float] = Field([1.0, 1.0, 1.0], min_length=3, max_length=3)


class LutCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = Field("", max_length=4000)
    params: LutParamsModel


class LutUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=4000)
    params: Optional[LutParamsModel] = None


class LutOut(BaseModel):
    id: int
    name: str
    description: str
    params: LutParamsModel
    created_at: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    params: Optional[LutParamsModel] = None
    history: Optional[List[str]] = Field(None, max_length=12)
    session_id: Optional[int] = None


class ChatResponse(BaseModel):
    reply: str = ""
    params: Optional[LutParamsModel] = None
    done: bool = False
    cube_text: Optional[str] = None
    error: Optional[str] = None
    session_id: Optional[int] = None


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
    )


app = FastAPI(title="CHROMA LUT API")
db.init_db()


def _secure_cookie() -> bool:
    return os.environ.get("CHROMA_ENV", "").strip().lower() in ("production", "prod")


def _safe_stem(name: str) -> str:
    """下载文件名主干:去掉路径分隔符与控制字符(含 CR/LF),避免变成路径或被用坏。"""
    cleaned = "".join(ch for ch in name if ch.isprintable() and ch not in "/\\")
    return cleaned.strip() or "lut"


def _content_disposition(stem: str, mode: str) -> str:
    """构造下载头:filename* 保真 UTF-8,filename 作为老客户端兜底(纯 ASCII)。"""
    mode = "camera" if mode == "camera" else "software"  # 白名单,不信调用方
    full = camera_file_name(stem) if mode == "camera" else f"{stem}_{mode}.cube"
    ascii_fallback = "".join(ch if ch.isascii() and ch.isprintable() and ch not in '\\"' else "_" for ch in full)
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(full)}"


def camera_file_name(name: str) -> str:
    """松下 FAT32 导入可用的 8 位 ASCII 文件主名。"""
    h = 0x811c9dc5
    for byte in name.encode("utf-8"):
        h = ((h ^ byte) * 0x01000193) & 0xffffffff
    return f"{h:08X}.cube"


@app.post("/api/luts", response_model=LutOut)
def create_lut(body: LutCreate, user: dict = Depends(auth.get_current_user)):
    params_json = body.params.model_dump_json()
    lut_id = db.create_lut(user["id"], body.name, body.description, params_json)
    return _record_to_out(db.get_lut(lut_id, user["id"]))


@app.get("/api/luts", response_model=List[LutOut])
def list_luts(user: dict = Depends(auth.get_current_user)):
    return [_record_to_out(r) for r in db.list_luts(user["id"])]


@app.get("/api/luts/{lut_id}", response_model=LutOut)
def get_lut(lut_id: int, user: dict = Depends(auth.get_current_user)):
    rec = db.get_lut(lut_id, user["id"])
    if not rec:
        raise HTTPException(status_code=404, detail="LUT not found")
    return _record_to_out(rec)


@app.put("/api/luts/{lut_id}", response_model=LutOut)
def update_lut(lut_id: int, body: LutUpdate, user: dict = Depends(auth.get_current_user)):
    rec = db.get_lut(lut_id, user["id"])
    if not rec:
        raise HTTPException(status_code=404, detail="LUT not found")
    name = body.name if body.name is not None else rec["name"]
    description = body.description if body.description is not None else rec["description"]
    params_json = body.params.model_dump_json() if body.params is not None else rec["params_json"]
    db.update_lut(lut_id, user["id"], name, description, params_json)
    return _record_to_out(db.get_lut(lut_id, user["id"]))


@app.delete("/api/luts/{lut_id}", status_code=204)
def delete_lut(lut_id: int, user: dict = Depends(auth.get_current_user)):
    if not db.delete_lut(lut_id, user["id"]):
        raise HTTPException(status_code=404, detail="LUT not found")


@app.get("/api/luts/{lut_id}/download")
def download_lut(
    lut_id: int,
    mode: Literal["camera", "software"] = "camera",
    user: dict = Depends(auth.get_current_user),
):
    """下载 .cube。mode=camera 注入松下机内头,mode=software 输出标准 .cube。"""
    rec = db.get_lut(lut_id, user["id"])
    if not rec:
        raise HTTPException(status_code=404, detail="LUT not found")
    engine_params = lut_params_from_dict(json.loads(rec["params_json"]))
    lut = generate_lut(engine_params, size=33)
    photo_style = engine_params.base_photo_style if mode == "camera" else None
    text = lut_to_cube(lut, title=rec["name"], photo_style=photo_style)
    return Response(
        content=text,
        media_type="application/octet-stream",
        headers={"Content-Disposition": _content_disposition(_safe_stem(rec["name"]), mode)},
    )


def _build_extract_fn(body: "ChatRequest", full_params: dict | None):
    """构造「消息 → 结构化参数」的提取函数。

    设置 CHROMA_FAKE_LLM=confirm 时用一个固定返回 confirm 的桩替代真实 LLM:
    端到端跑通「生成 → 落库 → 重开会话恢复」链路,不消耗真实 API 配额。
    """
    if os.environ.get("CHROMA_FAKE_LLM", "").strip().lower() == "confirm":
        return lambda msg: {"intent": "confirm"}

    from agent.llm import get_llm, extract_result

    client = get_llm()
    return lambda msg: extract_result(client, msg, params=full_params, history=body.history)


@app.post("/api/session/chat", response_model=ChatResponse)
def chat(body: ChatRequest, user: dict = Depends(auth.get_current_user)):
    """会话生成:LLM 从描述提取参数,参数齐全则生成 LUT。"""
    from agent.graph import run_agent
    from agent.llm import BudgetExhaustedError

    session_id = body.session_id
    if session_id is None:
        session_id = db.create_session(user["id"], "新会话")
    elif not db.get_session(session_id, user["id"]):
        raise HTTPException(status_code=404, detail="会话不存在")

    full_params = body.params.model_dump() if body.params else None
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
    try:
        result = run_agent(_build_extract_fn(body, full_params), body.message, params=initial)
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

    db.add_message(user["id"], session_id, "user", body.message, None)
    db.add_message(
        user["id"],
        session_id,
        "agent",
        reply,
        params_out.model_dump_json() if params_out else None,
        cube_text,
    )

    return ChatResponse(
        reply=reply,
        params=params_out,
        done=done,
        cube_text=cube_text,
        error=error,
        session_id=session_id,
    )


@app.post("/api/sessions", response_model=SessionOut)
def create_session(body: SessionCreate, user: dict = Depends(auth.get_current_user)):
    sid = db.create_session(user["id"], body.title)
    rec = db.get_session(sid, user["id"])
    return SessionOut(id=rec["id"], title=rec["title"], created_at=rec["created_at"])


@app.get("/api/sessions", response_model=List[SessionOut])
def list_sessions(user: dict = Depends(auth.get_current_user)):
    return [SessionOut(id=r["id"], title=r["title"], created_at=r["created_at"]) for r in db.list_sessions(user["id"])]


@app.delete("/api/sessions/{session_id}", status_code=204)
def delete_session(session_id: int, user: dict = Depends(auth.get_current_user)):
    if not db.delete_session(session_id, user["id"]):
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


class AutoGradeIssueOut(BaseModel):
    code: str
    severity: float
    evidence: str


class AutoGradeOut(BaseModel):
    params: LutParamsModel
    before_params: Optional[LutParamsModel] = None
    session_id: Optional[int] = None
    issues: List[AutoGradeIssueOut] = Field(default_factory=list)
    steps: List[AutoGradeStepOut] = Field(default_factory=list)
    style_params: Optional[dict] = None          # 风格提议(可能未被应用)
    style_applied: bool = False                  # 提议是否真的生效
    style_applied_params: Optional[dict] = None  # 真正生效的部分
    style_rejections: List[str] = Field(default_factory=list)
    review: Optional[str] = None
    # 视觉复核未执行的原因:disabled(用户关闭)/ failed(调用失败)/ no_client(未配置模型)
    review_skip_reason: Optional[str] = None
    degraded: bool = False
    usage: dict = Field(default_factory=dict)


class AutoGradeReportOut(AutoGradeOut):
    """报告查询的响应:比生成时的输出多一个 session_id,
    前端据此判断「这份报告是不是属于我正打开的会话」。"""
    session_id: int


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
    user: dict = Depends(auth.get_current_user),
):
    """AI 自动修图。

    `base_params` **必填且不接受默认值**:增量语义下「用默认值兜底」会把用户手调静默抹掉。
    """
    from photo import render as photo_render
    from photo import stats as photo_stats
    from agent.auto import auto_grade as run_auto_grade
    from agent.llm import BudgetExhaustedError
    from photo.types import ImageTooLargeError, PhotoError

    # 1) 参数解析(base_params 非法直接 422)
    try:
        parsed = LutParamsModel(**json.loads(base_params))
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"base_params 非法:{exc}")

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
        img = photo_stats.load_image(raw)
    except ImageTooLargeError as exc:
        # 像素数超限也是「太大」,应是 413 而不是 400
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except PhotoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 校验通过后才扣配额；先原子预留再执行昂贵的模型调用。
    retry = db.reserve_auto_grade_call(user["id"], ratelimit.AUTO_MAX_PER_WINDOW,
                                       ratelimit.AUTO_WINDOW_SECONDS)
    if retry:
        raise HTTPException(
            status_code=429,
            detail=f"自动修图次数已达上限,请在 {max(1, retry // 60)} 分钟后重试",
            headers={"Retry-After": str(retry)},
        )

    # 3) 编排
    style_text = (style or "").strip()[:200] or None
    client = None
    style_extractor = None
    if os.environ.get("CHROMA_FAKE_GRADE", "").strip():
        pass                                   # 测试桩:完全不调用 LLM
    else:
        from agent.llm import extract_result, get_llm
        client = get_llm()

        def style_extractor(_client, text):     # noqa: ANN001
            # 风格复用现有抽取路径 —— 不另立一套参数字典
            return extract_result(_client, text)

    try:
        result = run_auto_grade(
            img,
            parsed.model_dump(),
            style=style_text,
            client=client,
            use_vision=use_vision and client is not None,
            max_rounds=max(1, min(3, int(max_rounds))),
            style_extractor=style_extractor,
        )
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
                                rejections=st.rejections)
               for st in result.steps],
        style_params=result.style_params,
        style_applied=result.style_applied,
        style_applied_params=result.style_applied_params,
        style_rejections=result.style_rejections,
        review=result.review,
        review_skip_reason=result.review_skip_reason,
        degraded=result.degraded,
        usage=result.usage,
    )
    # 4) 落库(图片不落库,只存参数与说明摘要)
    try:
        out.session_id = _persist_auto_grade(user["id"], out)
    except Exception as exc:
        logger.exception("auto/grade 结果保存失败")
        raise HTTPException(status_code=503, detail="修图结果保存失败,请稍后重试") from exc
    return out


def _persist_auto_grade(user_id: int, out: AutoGradeOut) -> int:
    """把自动修图结果写进该用户的**唯一**自动修图会话,返回 session_id。

    两个设计点:
    - 复用单一会话:否则每点一次就多一个同名会话,把用户的创作会话挤出列表。
    - 结构化结果存 payload_json(完整 AutoGradeOut),刷新后据此重建报告;
      content 仍写人类可读摘要,两者并存、互不污染。
    不写 cube_text —— 避免又一次 0.9MB 落库。
    """
    sid = db.get_or_create_auto_session(user_id)
    lines = [f"AI 自动修图:{len(out.steps)} 步"]
    for st in out.steps:
        mark = "已应用" if st.applied else "被拦下"
        lines.append(f"  [{st.stage}] {st.diagnosis}({mark})")
    if out.degraded:
        lines.append("  未能完全达标,已采用保守调整")
    if out.review:
        lines.append(f"  视觉复核:{out.review}")
    elif out.review_skip_reason:
        lines.append(f"  视觉复核未执行({out.review_skip_reason})")
    db.add_message(user_id, sid, "agent", "\n".join(lines),
                   out.params.model_dump_json(), None, out.model_dump_json())
    return sid


@app.get("/api/auto/report", response_model=Optional[AutoGradeReportOut])
def get_auto_report(user: dict = Depends(auth.get_current_user)):
    """取该用户最近一次自动修图结果,供前端刷新后重建报告。

    返回带 session_id:前端据此判断该不该在当前打开的会话里展示 ——
    否则在别的会话里也会弹出上一份报告。

    没有记录时返回 null(而不是 404)—— 「还没修过图」是正常状态,不是错误。
    """
    sid = db.find_auto_session(user["id"])
    if sid is None:
        return None
    rec = db.get_latest_payload_message(sid, user["id"])
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
def undo_auto_grade(user: dict = Depends(auth.get_current_user)):
    sid = db.find_auto_session(user["id"])
    rec = db.get_latest_payload_message(sid, user["id"]) if sid is not None else None
    if not rec:
        raise HTTPException(status_code=404, detail="没有可撤销的修图")
    try:
        payload = json.loads(rec["payload_json"])
        before = LutParamsModel(**payload["before_params"])
        if payload.get("undone"):
            raise ValueError("already undone")
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=404, detail="没有可撤销的修图")
    db.add_message(user["id"], sid, "agent", "已撤销自动修图", before.model_dump_json(),
                   None, json.dumps({"undone": True}))
    return {"params": before}


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
