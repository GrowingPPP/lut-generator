"""有界、无文件持久化的照片规范化与导出接口。"""
import hashlib
import json
import re
import threading
import os
from contextlib import contextmanager
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import ValidationError

from . import auth
from .models import LutParamsModel
from photo.color_management import MAX_PHOTO_BYTES, PREVIEW_SIDE, decode_photo, encode_preview, display_rgb
from photo.export import export_photo
from photo import render as R
from photo.types import ImageTooLargeError, PhotoError
from photo import stats as S
from agent.subjects import detect_subjects

router = APIRouter(prefix="/api/photos", tags=["photos"])
_slots = threading.BoundedSemaphore(2)


@contextmanager
def photo_slot():
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "照片处理繁忙，请稍后重试")
    try:
        yield
    finally:
        _slots.release()


def read_photo(request: Request, file: UploadFile) -> bytes:
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_PHOTO_BYTES + 1024 * 1024:
        raise HTTPException(413, "图片过大，请压缩到 32MB 以内")
    raw = file.file.read(MAX_PHOTO_BYTES + 1)
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "图片过大，请压缩到 32MB 以内")
    return raw


def photo_error(exc):
    return HTTPException(413 if isinstance(exc, ImageTooLargeError) else 400, str(exc))


def subject_client(user_id, enabled):
    if not enabled or os.environ.get("CHROMA_FAKE_GRADE"):
        return None
    from agent.llm import get_llm
    try:
        client = get_llm()
    except Exception:
        return None
    from storage import db
    from . import ratelimit
    retry = db.reserve_auto_grade_call(user_id, ratelimit.AUTO_MAX_PER_WINDOW,
                                      ratelimit.AUTO_WINDOW_SECONDS)
    if retry:
        raise HTTPException(429, "图像分析与自动修图额度已用完，请稍后重试",
                            headers={"Retry-After": str(retry)})
    return client


@router.post("/normalize")
def normalize_photo(request: Request, file: UploadFile = File(...),
                    input_style: Literal["STD", "NAT", "VIVD", "VLOG"] = Form("STD"),
                    resolution: Literal["preview", "original"] = Form("preview"),
                    user=Depends(auth.get_current_user)):
    with photo_slot():
        raw = read_photo(request, file)
        try:
            photo = decode_photo(raw, input_style,
                                 max_side=None if resolution == "original" else PREVIEW_SIDE)
            data = encode_preview(photo)
        except PhotoError as exc:
            raise photo_error(exc) from exc
    metadata = {**photo.metadata, "source_digest": hashlib.sha256(raw).hexdigest()}
    return Response(data, media_type="image/png", headers={
        "Cache-Control": "no-store", "X-Photo-Metadata": json.dumps(metadata, ensure_ascii=True, separators=(",", ":")),
    })


@router.post("/subjects")
def analyze_photo_subjects(request: Request, response: Response, file: UploadFile = File(...),
                           input_style: Literal["STD", "NAT", "VIVD", "VLOG"] = Form("STD"),
                           source_digest: str = Form(..., pattern=r"^[0-9a-f]{64}$"),
                           enabled: bool = Form(True), tone_map: float = Form(1.0, ge=0, le=1),
                           params: str | None = Form(None, max_length=262144),
                           user=Depends(auth.get_current_user)):
    """分析同源显示原图；只保存返回的区域证据，不持久化图像。"""
    from lut_engine import technical_baseline_params
    parsed = {"base_photo_style": input_style, "tone_map": tone_map}
    if params is not None:
        try:
            parsed = LutParamsModel.model_validate(json.loads(params)).model_dump()
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "照片输入参数无效") from exc
        if parsed["base_photo_style"] != input_style:
            raise HTTPException(409, "人物识别与照片输入基准不一致")
    with photo_slot():
        raw = read_photo(request, file)
        if hashlib.sha256(raw).hexdigest() != source_digest:
            raise HTTPException(409, "照片内容与所选样张不同，请重新绑定来源文件")
        try:
            photo = decode_photo(raw, input_style, max_side=PREVIEW_SIDE)
            from api.imported_luts import resolver_for_user
            with R.using_lut_resolver(resolver_for_user(user["id"])):
                image = S.load_image(encode_preview(photo), base_photo_style=input_style)
                baseline = R.render_lut(R.lut_from_params(technical_baseline_params(parsed)), image)
                display = display_rgb(baseline, input_style)
            client = subject_client(user["id"], enabled)
            analysis, _usage = detect_subjects(client, display, enabled=enabled)
        except PhotoError as exc:
            raise photo_error(exc) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    analysis.update(source_digest=source_digest, input_style=input_style)
    response.headers["Cache-Control"] = "no-store"
    return analysis


@router.post("/export")
def export_adjusted_photo(request: Request, file: UploadFile = File(...),
                          params: str = Form(..., max_length=262144),
                          source_digest: str = Form(..., min_length=64, max_length=64),
                          format: Literal["jpeg", "png"] = Form("jpeg"),
                          quality: int = Form(95, ge=80, le=100),
                          user=Depends(auth.get_current_user)):
    try:
        parsed = LutParamsModel.model_validate(json.loads(params))
    except (json.JSONDecodeError, ValidationError, TypeError, ValueError) as exc:
        raise HTTPException(422, "照片调色参数无效") from exc
    if not re.fullmatch(r"[0-9a-fA-F]{64}", source_digest):
        raise HTTPException(422, "照片来源摘要无效")
    with photo_slot():
        raw = read_photo(request, file)
        if hashlib.sha256(raw).hexdigest() != source_digest.lower():
            raise HTTPException(409, "照片内容与所选样张不同，请重新绑定来源文件")
        try:
            from api.imported_luts import resolver_for_user
            with R.using_lut_resolver(resolver_for_user(user["id"])):
                result = export_photo(raw, parsed.model_dump(), output_format=format, quality=quality)
        except PhotoError as exc:
            raise photo_error(exc) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    stem = re.sub(r"[\x00-\x1f\x7f/\\]", "_", (file.filename or "photo").rsplit(".", 1)[0]).strip()[:120] or "photo"
    name = f"{stem}_adjusted_sRGB.{ 'jpg' if format == 'jpeg' else 'png'}"
    return Response(result.data, media_type=result.media_type, headers={
        "Content-Disposition": f"attachment; filename=photo_adjusted.{ 'jpg' if format == 'jpeg' else 'png'}; filename*=UTF-8''{quote(name, safe='')}",
        "Cache-Control": "no-store", "X-Photo-Width": str(result.width),
        "X-Photo-Height": str(result.height), "X-Photo-Color-Space": "sRGB",
    })
