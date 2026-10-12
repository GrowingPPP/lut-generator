"""短期自动修图作业；照片与未完成候选只存在执行线程内存中。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
from io import BytesIO
import json
import logging
import os
import shlex
import sys
from threading import Event, RLock
import time
from typing import Callable, Literal, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile

from agent.auto import AutoGradeCancelled
from api import auth

logger = logging.getLogger("chroma.auto_jobs")
TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled"})
STAGES = ("subjects", "measure", "optimize", "style", "rules", "review", "save")


class JobNotFound(Exception):
    pass


class JobLimitExceeded(Exception):
    pass


class JobContinuationRejected(Exception):
    pass


class JobRequestConflict(Exception):
    pass


class JobRequestExpired(Exception):
    pass


class JobRequestBlocked(Exception):
    pass


@dataclass
class _Job:
    id: str
    user_id: int
    workspace_id: Optional[str]
    source_digest: Optional[str]
    main_sample_id: Optional[str]
    created_at: float
    updated_at: float
    expires_at: float
    status: str = "queued"
    stages: dict = field(default_factory=lambda: {
        stage: {"stage": stage, "state": "pending", "round": 0} for stage in STAGES})
    progress: dict = field(default_factory=lambda: {"stage": "subjects", "state": "pending", "round": 0})
    cancelled: Event = field(default_factory=Event)
    committing: bool = False
    result: Optional[dict] = None
    error: Optional[dict] = None
    persisted: bool = False
    request_data: dict = field(default_factory=dict)
    continuation_stages: list = field(default_factory=list)
    continued_from: Optional[str] = None
    fingerprint: Optional[str] = None


class AutoJobRegistry:
    """一个服务进程内的有界作业集，取消与开始保存共享同一判定锁。"""

    def __init__(self, max_active=2, max_per_user=1, ttl_seconds=900,
                 active_seconds=600, max_retained=200, clock=time.time, executor=None):
        self.max_active = max_active
        self.max_per_user = max_per_user
        self.ttl_seconds = ttl_seconds
        self.active_seconds = active_seconds
        self.max_retained = max_retained
        self.clock = clock
        self.executor = executor or ThreadPoolExecutor(max_workers=max_active, thread_name_prefix="auto-grade")
        self._jobs = {}
        self._expired = {}
        self._blocked = {}
        self._lock = RLock()

    def _forget(self, job, now):
        self._expired[job.id] = (job.user_id, job.fingerprint, now + 86400)
        del self._jobs[job.id]

    def _snapshot(self, job):
        return deepcopy({
            "id": job.id, "status": job.status, "progress": job.progress,
            "stages": list(job.stages.values()), "workspace_id": job.workspace_id,
            "source_digest": job.source_digest, "main_sample_id": job.main_sample_id,
            "created_at": job.created_at, "updated_at": job.updated_at,
            "expires_at": job.expires_at, "result": job.result,
            "error": job.error, "persisted": job.persisted,
            "can_cancel": job.status not in TERMINAL_STATUSES and not job.committing,
            "continuation_stages": job.continuation_stages, "continued_from": job.continued_from,
        })

    def _finish(self, job, status, error=None):
        job.status = status
        job.error = error
        job.updated_at = self.clock()
        job.expires_at = job.updated_at + self.ttl_seconds

    def cleanup(self):
        with self._lock:
            now = self.clock()
            for job_id, job in list(self._jobs.items()):
                if job.status in TERMINAL_STATUSES and job.expires_at <= now:
                    self._forget(job, now)
                elif job.status not in TERMINAL_STATUSES and not job.committing and job.expires_at <= now:
                    job.cancelled.set()
                    job.status = "cancelling"
            terminal = sorted((j for j in self._jobs.values() if j.status in TERMINAL_STATUSES),
                              key=lambda j: j.updated_at)
            while len(self._jobs) >= self.max_retained and terminal:
                self._forget(terminal.pop(0), now)
            self._expired = {key: value for key, value in self._expired.items() if value[2] > now}
            while len(self._expired) > 2000:
                del self._expired[next(iter(self._expired))]
            self._blocked = {key: value for key, value in self._blocked.items() if value[2] > now}

    def replay(self, request_id, user_id, fingerprint):
        with self._lock:
            self.cleanup()
            blocked = self._blocked.get(request_id)
            if blocked:
                if blocked[0] != user_id:
                    raise JobNotFound()
                raise JobRequestBlocked()
            if request_id in self._jobs:
                previous = self._owned(request_id, user_id)
                if previous.fingerprint != fingerprint:
                    raise JobRequestConflict()
                return self._snapshot(previous)
            expired = self._expired.get(request_id)
            if expired:
                if expired[0] != user_id:
                    raise JobNotFound()
                if expired[1] != fingerprint:
                    raise JobRequestConflict()
                raise JobRequestExpired()
            return None

    def submit(self, user_id, workspace_id, source_digest, main_sample_id,
               run: Callable, persist: Callable, reserve: Optional[Callable] = None,
               request_data=None, continued_from=None, request_id=None, fingerprint=None):
        with self._lock:
            self.cleanup()
            repeated = self.replay(request_id, user_id, fingerprint)
            if repeated is not None:
                return repeated
            active = [j for j in self._jobs.values() if j.status not in TERMINAL_STATUSES]
            if (len(active) >= self.max_active
                    or sum(j.user_id == user_id for j in active) >= self.max_per_user):
                raise JobLimitExceeded()
            if reserve is not None:
                reserve()
            now = self.clock()
            job = _Job(request_id or str(uuid4()), user_id, workspace_id, source_digest, main_sample_id,
                       now, now, now + self.active_seconds,
                       request_data=deepcopy(request_data or {}), continued_from=continued_from,
                       fingerprint=fingerprint)
            self._jobs[job.id] = job
            initial = self._snapshot(job)
            try:
                self.executor.submit(self._execute, job, run, persist)
            except Exception:
                del self._jobs[job.id]
                raise
            return initial

    def _owned(self, job_id, user_id):
        job = self._jobs.get(job_id)
        if job is None or job.user_id != user_id:
            raise JobNotFound()
        return job

    def get(self, job_id, user_id):
        with self._lock:
            self.cleanup()
            return self._snapshot(self._owned(job_id, user_id))

    def cancel(self, job_id, user_id):
        with self._lock:
            self.cleanup()
            job = self._owned(job_id, user_id)
            if job.status not in TERMINAL_STATUSES and not job.committing:
                job.cancelled.set()
                job.status = "cancelling"
                job.updated_at = self.clock()
            return self._snapshot(job)

    def cancel_all(self):
        with self._lock:
            for job in self._jobs.values():
                if job.status not in TERMINAL_STATUSES and not job.committing:
                    job.cancelled.set()
                    job.status = "cancelling"
                    job.updated_at = self.clock()

    def prevent_late(self, job_id, user_id, workspace_id):
        with self._lock:
            self.cleanup()
            if job_id in self._jobs:
                job = self._owned(job_id, user_id)
                if workspace_id != job.workspace_id:
                    raise JobNotFound()
                return self.cancel(job_id, user_id)
            previous = self._blocked.get(job_id) or self._expired.get(job_id)
            if previous and previous[0] != user_id:
                raise JobNotFound()
            if job_id in self._blocked and self._blocked[job_id][1] != workspace_id:
                raise JobNotFound()
            if len(self._blocked) >= 2000 and job_id not in self._blocked:
                raise JobLimitExceeded()
            self._blocked[job_id] = (user_id, workspace_id, self.clock() + 86400)
            return {"id": job_id, "status": "cancelled", "persisted": False, "result": None,
                    "can_cancel": False, "not_accepted": True, "workspace_id": workspace_id,
                    "stages": [], "progress": None, "continuation_stages": [], "error": None}

    def continuation_request(self, job_id, user_id, params, context, workspace_id,
                             source_digest, main_sample_id, actual_digest):
        with self._lock:
            self.cleanup()
            job = self._owned(job_id, user_id)
            if (job.status != "succeeded" or not job.persisted or not job.continuation_stages
                    or not job.workspace_id or not job.source_digest or not job.main_sample_id):
                raise JobContinuationRejected("该作业没有可继续的已应用阶段，请使用当前条件重新开始")
            if (params != job.result.get("params") or context != job.request_data.get("context")
                    or workspace_id != job.workspace_id or source_digest != job.source_digest
                    or main_sample_id != job.main_sample_id
                    or actual_digest != job.request_data.get("actual_digest")):
                raise JobContinuationRejected("已应用候选、上下文或来源已变化，不能继续原阶段")
            data = deepcopy(job.request_data)
            data["resume"] = {
                "skip_correction": "optimize" not in job.continuation_stages,
                "skip_style": "style" not in job.continuation_stages,
                "completed_style_targets": job.result.get("style_applied_params")
                                           or job.request_data.get("resume", {}).get("completed_style_targets") or {},
                "style_rejections": job.result.get("style_rejections") or [],
                "blocked_reasons": job.result.get("blocked_reasons") or [],
            }
            return data

    def _execute(self, job, run, persist):
        def cancelled():
            if self.clock() >= job.expires_at and not job.committing:
                job.cancelled.set()
            return job.cancelled.is_set()

        def progress(event):
            with self._lock:
                if job.status in TERMINAL_STATUSES or job.cancelled.is_set():
                    return
                stage, state = event.get("stage"), event.get("state")
                if stage not in STAGES or state not in {"pending", "running", "done", "skipped"}:
                    return
                value = {"stage": stage, "state": state,
                         "round": event.get("round") or job.stages[stage]["round"]}
                if event.get("reason") in {"goal", "locked", "no_issues", "no_client", "disabled",
                                           "not_requested", "not_needed", "failed", "blocked", "unchanged",
                                           "no_writable_fields", "continued", "empty"}:
                    value["reason"] = event["reason"]
                job.progress = value
                job.stages[stage] = value
                job.updated_at = self.clock()

        try:
            with self._lock:
                if cancelled():
                    self._finish(job, "cancelled")
                    return
                job.status = "running"
            result = run(progress, cancelled)
            result["job_id"] = job.id
            result["job_fingerprint"] = job.fingerprint
            with self._lock:
                if cancelled():
                    self._finish(job, "cancelled")
                    return
                job.continuation_stages = result.pop("_continuation_stages", [])
                job.committing = True
                progress({"stage": "save", "state": "running"})
            saved = persist(result)
            with self._lock:
                job.result = deepcopy(saved)
                job.persisted = True
                progress({"stage": "save", "state": "done"})
                self._finish(job, "succeeded")
        except AutoGradeCancelled:
            with self._lock:
                self._finish(job, "cancelled")
        except Exception:
            logger.exception("自动修图作业失败，作业 %s", job.id)
            with self._lock:
                if cancelled() and not job.committing:
                    self._finish(job, "cancelled")
                else:
                    self._finish(job, "failed", {"code": "save_failed" if job.committing else "analysis_failed",
                        "message": "结果保存失败，请重试" if job.committing else "来源、额度或分析服务未能完成，请核对后重试"})


registry = AutoJobRegistry()
router = APIRouter(prefix="/api/auto/jobs")


@router.on_event("shutdown")
def cancel_pending_jobs():
    registry.cancel_all()


def require_single_worker():
    tokens = sys.argv[1:] + shlex.split(os.environ.get("GUNICORN_CMD_ARGS", ""))
    counts = [os.environ.get("WEB_CONCURRENCY", "1"), os.environ.get("CHROMA_AUTO_JOB_WORKERS", "1")]
    for i, token in enumerate(tokens):
        if token in {"--workers", "-w"} and i + 1 < len(tokens):
            counts.append(tokens[i + 1])
        elif token.startswith("--workers="):
            counts.append(token.split("=", 1)[1])
        elif token.startswith("-w") and token[2:].isdigit():
            counts.append(token[2:])
    if any(value != "1" for value in counts):
        raise HTTPException(503, {"code": "single_worker_required", "accepted": False,
                                  "message": "自动修图作业要求单个服务 worker，请按单进程部署后重试"})


def continuation_stages(img, out, style, context, resume=None):
    """只为有正式贡献的部分完成结果提供可写、仍未完成的调色阶段。"""
    from agent.editing import application_reasons, normalize_context, writable_fields
    from photo import quality, render, stats
    if out.goal_status != "partially_met" or not any(step.applied for step in out.steps):
        return []
    ctx = normalize_context(context)
    result = out.params.model_dump()
    before_style = next((step.params_before for step in out.steps
                         if step.stage == "style" and step.params_before), result)
    stages = []
    if ctx.goal_mode != "style_only" and writable_fields(ctx, "correction"):
        measured = stats.analyze(render.render_lut(render.lut_from_params(before_style), img))
        if not quality.is_goal_met(measured, ctx.goal_mode):
            stages.append("optimize")
    targets = out.style_applied_params or (resume or {}).get("completed_style_targets") or out.style_params or {}
    style_done = bool(targets) and not out.style_rejections and all(result.get(k) == v for k, v in targets.items())
    permission_blocked = any("已锁定" in reason or "在自动修图中只读" in reason for reason in out.style_rejections)
    if style and not style_done and not permission_blocked and writable_fields(ctx, "style"):
        candidate = {**result, **targets}
        if not application_reasons(result, candidate, ctx, "style"):
            stages.append("style")
    return stages


def _job_response(action, job_id, user_id):
    try:
        return action(job_id, user_id)
    except JobNotFound as exc:
        raise HTTPException(404, {"code": "expired_or_restarted",
                                  "message": "作业不存在、已过期或服务已重启；当前草稿未应用该结果"}) from exc


def _saved_job(job_id, user_id, workspace_id=None):
    from storage import db
    result = db.find_auto_job_report(user_id, job_id, workspace_id)
    if not result:
        return None
    return {"id": job_id, "status": "succeeded", "persisted": True, "result": result,
            "can_cancel": False, "workspace_id": result.get("workspace_id"),
            "source_digest": result.get("source_digest"), "main_sample_id": result.get("main_sample_id"),
            "recovered_from_report": True, "stages": [], "progress": None,
            "continuation_stages": [], "continued_from": result.get("continued_from"), "error": None}


def _request_blocked():
    return HTTPException(409, {"code": "request_blocked", "accepted": False,
                              "message": "此请求已明确结束，不会重新提交；请使用新的请求标识重新开始"})


def _request_fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode()).hexdigest()


def _saved_fingerprint_matches(result, data):
    """旧报告仅省略当时不存在、且本次仍为默认值的上下文字段。"""
    saved_fingerprint = result.get("job_fingerprint")
    if saved_fingerprint == _request_fingerprint(data):
        return True
    saved_context, context = result.get("context"), data.get("context")
    if not isinstance(saved_context, dict) or not isinstance(context, dict):
        return False
    defaults = {"subject_mode": "unknown", "subject_detection_mode": "manual",
                "subject_analysis": None, "skin_regions": None, "skin_mask_mode": "skin_candidates"}
    omitted = {key for key, value in defaults.items()
               if key not in saved_context and key in context and context[key] == value}
    if not omitted:
        return False
    legacy_context = {key: value for key, value in context.items() if key not in omitted}
    return saved_fingerprint == _request_fingerprint({**data, "context": legacy_context})


@router.post("", status_code=202)
def create_job(request: Request, file: UploadFile = File(...),
               base_params: str = Form(..., max_length=8192), style: Optional[str] = Form(None),
               use_vision: bool = Form(True), max_rounds: int = Form(2),
               workspace_id: Optional[str] = Form(None, max_length=36),
               context: Optional[str] = Form(None, max_length=8192),
               source_digest: Optional[str] = Form(None, max_length=128),
               main_sample_id: Optional[str] = Form(None, max_length=128),
               continue_from: Optional[str] = Form(None, max_length=36),
               request_id: Optional[str] = Form(None, max_length=36),
               sample_origin: Literal["source", "restored_preview"] = Form("source"),
               user: dict = Depends(auth.get_current_user)):
    from api.main import (LutParamsModel, MAX_AUTO_IMAGE_BYTES, _prepare_auto_grade,
                          _compute_auto_grade, _persist_auto_grade, _reserve_auto_grade)
    from agent.editing import EditingContext, normalize_context
    from api.workspaces import require_subject_source
    require_single_worker()
    try:
        parsed = LutParamsModel.model_validate(json.loads(base_params))
        ctx = EditingContext.model_validate(json.loads(context)) if context else None
        job_id = str(UUID(request_id)) if request_id else str(uuid4())
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, "参数、上下文或请求标识无效") from exc
    raw = file.file.read(MAX_AUTO_IMAGE_BYTES + 1)
    if len(raw) > MAX_AUTO_IMAGE_BYTES:
        raise HTTPException(413, "图片过大，请压缩到 32MB 以内")
    actual_digest = hashlib.sha256(raw).hexdigest()
    if source_digest and source_digest != actual_digest:
        raise HTTPException(409, "来源文件摘要不一致，请重新绑定主样张")
    require_subject_source(ctx, actual_digest, parsed.base_photo_style)
    require_subject_source(ctx, source_digest, parsed.base_photo_style)
    request_data = {"style": (style or "").strip()[:200] or None,
                    "use_vision": use_vision, "max_rounds": max_rounds,
                    "context": normalize_context(ctx).model_dump(), "actual_digest": actual_digest}
    fingerprint_data = {
        **request_data, "params": parsed.model_dump(), "workspace_id": workspace_id,
        "source_digest": source_digest, "main_sample_id": main_sample_id,
        "sample_origin": sample_origin, "continue_from": continue_from,
    }
    fingerprint = _request_fingerprint(fingerprint_data)
    try:
        repeated = registry.replay(job_id, user["id"], fingerprint)
        if repeated is not None:
            return repeated
    except JobNotFound as exc:
        raise HTTPException(404, "作业不存在") from exc
    except JobRequestConflict as exc:
        raise HTTPException(409, "请求标识已用于不同的修图条件，请重新开始") from exc
    except JobRequestExpired as exc:
        raise HTTPException(410, "原请求已失效，当前草稿未应用该结果；请明确重新开始") from exc
    except JobRequestBlocked as exc:
        raise _request_blocked() from exc
    saved = _saved_job(job_id, user["id"], workspace_id)
    if saved:
        if not _saved_fingerprint_matches(saved["result"], fingerprint_data):
            raise HTTPException(409, "请求标识已用于不同的修图条件，请重新开始")
        return saved
    if continue_from:
        try:
            previous = registry.continuation_request(continue_from, user["id"], parsed.model_dump(),
                       request_data["context"], workspace_id, source_digest, main_sample_id, actual_digest)
        except JobNotFound as exc:
            raise HTTPException(404, "来源作业不存在或已过期，不能继续") from exc
        except JobContinuationRejected as exc:
            raise HTTPException(409, str(exc)) from exc
        if any(request_data[key] != previous[key] for key in ("style", "use_vision", "max_rounds")):
            raise HTTPException(409, "原请求设置已变化，请使用当前条件重新开始")
        request_data = previous

    def run(progress, cancel_check):
        from api.imported_luts import resolver_for_user
        from photo.render import using_lut_resolver
        if cancel_check():
            raise AutoGradeCancelled()
        prepared = _prepare_auto_grade(request, UploadFile(file=BytesIO(raw)), base_params, context,
                                        workspace_id, sample_origin, user)
        if cancel_check():
            raise AutoGradeCancelled()
        _reserve_auto_grade(user["id"])
        with using_lut_resolver(resolver_for_user(user["id"])):
            out = _compute_auto_grade(prepared[0], prepared[1], prepared[2], request_data["style"], use_vision,
                                       max_rounds, workspace_id, source_digest, main_sample_id,
                                       progress=progress, cancel_check=cancel_check,
                                       resume=request_data.get("resume"), continued_from=continue_from,
                                       user_id=user["id"], actual_source_digest=actual_digest)
            return {**out.model_dump(), "_continuation_stages": continuation_stages(
                prepared[0], out, request_data["style"], prepared[2], request_data.get("resume"))}

    def persist(data):
        from api.main import AutoGradeOut
        out = AutoGradeOut.model_validate(data)
        out.session_id = _persist_auto_grade(user["id"], out)
        return out.model_dump()

    try:
        return registry.submit(user["id"], workspace_id, source_digest, main_sample_id,
                               run, persist, request_data=request_data, continued_from=continue_from,
                               request_id=job_id, fingerprint=fingerprint)
    except JobLimitExceeded as exc:
        raise HTTPException(429, "已有自动修图正在运行，请等待或取消后重试",
                            headers={"Retry-After": "2"}) from exc
    except JobNotFound as exc:
        raise HTTPException(404, "作业不存在") from exc
    except JobRequestConflict as exc:
        raise HTTPException(409, "请求标识已用于不同的修图条件，请重新开始") from exc
    except JobRequestExpired as exc:
        raise HTTPException(410, "原请求已失效，当前草稿未应用该结果；请明确重新开始") from exc
    except JobRequestBlocked as exc:
        raise _request_blocked() from exc


@router.get("/{job_id}")
def get_job(job_id: str, workspace_id: Optional[str] = None, user: dict = Depends(auth.get_current_user)):
    require_single_worker()
    try:
        job = registry.get(job_id, user["id"])
        if workspace_id and job["workspace_id"] != workspace_id:
            raise JobNotFound()
        return job
    except JobNotFound:
        saved = _saved_job(job_id, user["id"], workspace_id)
        if saved:
            return saved
        raise HTTPException(404, {"code": "expired_or_restarted",
                                  "message": "作业不存在、已过期或服务已重启；请核对当前草稿和来源"})


@router.delete("/{job_id}")
def cancel_job(job_id: str, workspace_id: Optional[str] = None, prevent_late: bool = False,
               user: dict = Depends(auth.get_current_user)):
    require_single_worker()
    if prevent_late:
        try:
            job_id = str(UUID(job_id))
        except ValueError as exc:
            raise HTTPException(422, "请求标识无效") from exc
        saved = _saved_job(job_id, user["id"], workspace_id)
        if saved:
            return saved
        try:
            return registry.prevent_late(job_id, user["id"], workspace_id)
        except JobNotFound as exc:
            raise HTTPException(404, "作业不存在") from exc
        except JobLimitExceeded as exc:
            raise HTTPException(429, "暂时不能确认请求结束，请稍后再试") from exc
    return _job_response(registry.cancel, job_id, user["id"])
