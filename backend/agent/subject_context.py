"""统一自动与人工人物证据，区域只用于调色质量检查。"""
from photo.subjects import MIN_SUBJECT_CONFIDENCE, subject_skin_mask
from .editing import normalize_context


def subject_evidence(context):
    ctx = normalize_context(context)
    detected = ctx.subject_analysis.model_dump() if ctx.subject_analysis else None
    mode = ctx.subject_mode
    if ctx.subject_detection_mode == "auto":
        mode = (detected["subject_mode"] if detected and detected["status"] == "resolved"
                and detected["confidence"] >= MIN_SUBJECT_CONFIDENCE else "unknown")
    manual = ctx.subject_detection_mode == "manual" or ctx.skin_regions is not None
    regions = (ctx.skin_regions if ctx.skin_regions is not None else
               ctx.subject_analysis.regions if detected and detected["status"] == "resolved"
               and detected["subject_mode"] == "portrait" else [])
    return {
        "version": "subject-regions-1", "status": "resolved" if mode != "unknown" else
        detected["status"] if detected and detected["status"] != "resolved" else "uncertain",
        "subject_mode": mode, "confidence": 1.0 if manual else detected["confidence"] if detected else 0.0,
        "regions": [region.model_dump() for region in regions] if mode == "portrait" else [],
        "source": "manual" if manual else "auto",
        "mask_mode": ctx.skin_mask_mode if ctx.skin_regions is not None else "skin_candidates",
        "reason": detected.get("reason") if detected else "no_regions",
    }


def protection_context(context):
    ctx = normalize_context(context)
    return ctx.model_copy(update={"subject_mode": subject_evidence(ctx)["subject_mode"]})


def protection_mask(display_img, context):
    return subject_skin_mask(display_img, subject_evidence(context))


def protection_report(context, stats):
    evidence = subject_evidence(context)
    count = round(stats.sampled_px * stats.skin_ratio)
    return {**evidence, "enabled": evidence["subject_mode"] == "portrait"
            and count >= 32 and stats.skin_mean_rgb is not None,
            "sampled_skin_px": count, "suspected_skin_ratio": stats.skin_ratio,
            "method": "manual_regions" if evidence["source"] == "manual" else "localized_regions",
            "detection": normalize_context(context).subject_analysis.model_dump()
            if normalize_context(context).subject_analysis else None}
