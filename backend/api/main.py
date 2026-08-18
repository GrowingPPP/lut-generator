"""LUT 管理 API。"""
import json
from dataclasses import asdict
from typing import List, Literal, Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api import auth
from lut_engine import generate_lut, lut_to_cube, lut_params_from_dict
from storage import db


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
    lift: List[float] = Field([0.0, 0.0, 0.0], min_length=3, max_length=3)
    gamma: List[float] = Field([1.0, 1.0, 1.0], min_length=3, max_length=3)
    gain: List[float] = Field([1.0, 1.0, 1.0], min_length=3, max_length=3)


class LutCreate(BaseModel):
    name: str
    description: str = ""
    params: LutParamsModel


class LutUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    params: Optional[LutParamsModel] = None


class LutOut(BaseModel):
    id: int
    name: str
    description: str
    params: LutParamsModel
    created_at: str


class ChatRequest(BaseModel):
    message: str
    params: Optional[LutParamsModel] = None
    history: Optional[List[str]] = None
    session_id: Optional[int] = None


class ChatResponse(BaseModel):
    reply: str = ""
    params: Optional[LutParamsModel] = None
    done: bool = False
    cube_text: Optional[str] = None
    error: Optional[str] = None
    session_id: Optional[int] = None


class SessionCreate(BaseModel):
    title: str = "新会话"


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
def download_lut(lut_id: int, mode: str = "camera", user: dict = Depends(auth.get_current_user)):
    """下载 .cube。mode=camera 注入松下机内头,mode=software 输出标准 .cube。"""
    rec = db.get_lut(lut_id, user["id"])
    if not rec:
        raise HTTPException(status_code=404, detail="LUT not found")
    engine_params = lut_params_from_dict(json.loads(rec["params_json"]))
    lut = generate_lut(engine_params, size=33)
    photo_style = engine_params.base_photo_style if mode == "camera" else None
    text = lut_to_cube(lut, title=rec["name"], photo_style=photo_style)
    safe_name = quote(rec["name"])
    return Response(
        content=text,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}_{mode}.cube"},
    )


@app.post("/api/session/chat", response_model=ChatResponse)
def chat(body: ChatRequest, user: dict = Depends(auth.get_current_user)):
    """会话生成:LLM 从描述提取参数,参数齐全则生成 LUT。"""
    from agent.graph import run_agent
    from agent.llm import get_llm, extract_result

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
    try:
        llm = get_llm()
        result = run_agent(
            lambda msg: extract_result(llm, msg, params=full_params, history=body.history),
            body.message,
            params=initial,
        )
        params_out = None
        if result.get("params"):
            clamped = lut_params_from_dict(result["params"])
            d = asdict(clamped)
            for k in ("lift", "gamma", "gain"):
                d[k] = list(d[k])
            params_out = LutParamsModel(**d)
    except Exception as e:
        return ChatResponse(reply=f"生成失败:{e}", error=str(e))

    db.add_message(session_id, "user", body.message, None)
    db.add_message(
        session_id,
        "agent",
        result.get("reply", ""),
        params_out.model_dump_json() if params_out else None,
    )

    return ChatResponse(
        reply=result.get("reply", ""),
        params=params_out,
        done=result.get("done", False),
        cube_text=result.get("cube_text"),
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


@app.get("/api/sessions/{session_id}/messages", response_model=List[MessageOut])
def list_messages(session_id: int, user: dict = Depends(auth.get_current_user)):
    session = db.get_session(session_id, user["id"])
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    out = []
    for m in db.list_messages(session_id):
        params = LutParamsModel(**json.loads(m["params_json"])) if m["params_json"] else None
        out.append(MessageOut(id=m["id"], role=m["role"], content=m["content"], params=params, created_at=m["created_at"]))
    return out


class RegisterRequest(BaseModel):
    username: str
    password: str = Field(min_length=8, max_length=72)


class LoginRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    token: str
    user_id: int
    username: str


@app.post("/api/auth/register", response_model=AuthResponse)
def register(body: RegisterRequest):
    if db.get_user_by_username(body.username):
        raise HTTPException(status_code=409, detail="用户名已存在")
    user_id = db.create_user(body.username, auth.hash_password(body.password))
    return AuthResponse(token=auth.create_token(user_id), user_id=user_id, username=body.username)


@app.post("/api/auth/login", response_model=AuthResponse)
def login(body: LoginRequest):
    user = db.get_user_by_username(body.username)
    if not user or not auth.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return AuthResponse(token=auth.create_token(user["id"]), user_id=user["id"], username=user["username"])
