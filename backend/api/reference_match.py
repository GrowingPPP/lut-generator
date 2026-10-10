"""有来源核对的参考图候选，照片不持久化。"""
import hashlib
import json
from threading import BoundedSemaphore

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from api import auth
from api.models import LutParamsModel
from api.workspaces import require_workspace
from agent.editing import EditingContext
from photo import stats as S, render as R
from agent.reference import match_reference
from photo.types import PhotoError, ImageTooLargeError
from storage import db
from lut_engine import CubeError

router = APIRouter(prefix="/api/reference")
_slots = BoundedSemaphore(2)
MAX_BYTES = 32 * 1024 * 1024


@router.post("/match")
def create_match(file: UploadFile = File(...), reference: UploadFile = File(...),
                 params: str = Form(..., max_length=16384), context: str = Form(..., max_length=8192),
                 workspace_id: str = Form(..., max_length=36), main_sample_id: str = Form(..., max_length=128),
                 source_digest: str = Form(..., min_length=64, max_length=64),
                 color: bool = Form(True), tone: bool = Form(True), strength: float = Form(0.7, ge=0, le=1),
                 user: dict = Depends(auth.get_current_user)):
    require_workspace(workspace_id, user["id"])
    try:
        parsed = LutParamsModel.model_validate(json.loads(params))
        ctx = EditingContext.model_validate(json.loads(context))
        if not color and not tone:
            raise ValueError("请至少选择色彩或影调匹配")
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "匹配参数或目标不合法") from exc
    raw = file.file.read(MAX_BYTES + 1)
    ref_raw = reference.file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES or len(ref_raw) > MAX_BYTES:
        raise HTTPException(413, "单张图片不能超过 32MB")
    if hashlib.sha256(raw).hexdigest() != source_digest:
        raise HTTPException(409, "来源照片与冻结请求不一致")
    _, retry = db.reserve_auth_event(f"reference:{user['id']}", 10, 60)
    if retry:
        raise HTTPException(429, "匹配请求过于频繁", headers={"Retry-After": str(retry)})
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "参考匹配正在处理，请稍后重试", headers={"Retry-After": "2"})
    try:
        image = S.load_image(raw, parsed.base_photo_style)
        target = S.load_image(ref_raw, "STD")
        from api.imported_luts import resolver_for_user
        with R.using_lut_resolver(resolver_for_user(user["id"])):
            out = match_reference(image, target, parsed.model_dump(), ctx,
                                  color=color, tone=tone, strength=strength)
        return {**out, "workspace_id": workspace_id, "main_sample_id": main_sample_id,
                "source_digest": source_digest, "reference_digest": hashlib.sha256(ref_raw).hexdigest(),
                "context": ctx.model_dump()}
    except ImageTooLargeError as exc:
        raise HTTPException(413, str(exc)) from exc
    except (CubeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except PhotoError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        _slots.release()
