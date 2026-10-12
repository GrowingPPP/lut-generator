"""参考照片的显示域色彩与影调匹配，不假定两张照片逐像素对应。"""
from copy import deepcopy

import numpy as np

from agent.editing import application_reasons, normalize_context
from lut_engine import lut_params_from_dict
from photo import render as R, stats as S, quality as Q

MATCH_VERSION = "distribution-match-1"
LUMA = np.array([0.2126, 0.7152, 0.0722])
COORDINATES = (
    ("contrast", None, 0.16, "tone"), ("highlights", None, 0.20, "tone"),
    ("shadows", None, 0.20, "tone"), ("whites", None, 0.12, "tone"),
    ("blacks", None, 0.12, "tone"), ("curve", None, 0.18, "tone"),
    ("saturation", None, 0.16, "color"), ("vibrance", None, 0.16, "color"),
    ("hue", None, 8.0, "color"),
    ("gain", 0, 0.06, "color"), ("gain", 1, 0.06, "color"), ("gain", 2, 0.06, "color"),
    ("gamma", 0, 0.05, "color"), ("gamma", 1, 0.05, "color"), ("gamma", 2, 0.05, "color"),
)


def matching_features(image, *, color=True, tone=True):
    pixels = np.asarray(image, dtype=np.float64).reshape(-1, 3)
    if not len(pixels) or not np.isfinite(pixels).all():
        raise ValueError("参考匹配需要有效 RGB 像素")
    luma = pixels @ LUMA
    parts = []
    if tone:
        parts.extend(np.quantile(luma, [0.05, 0.25, 0.5, 0.75, 0.95]))
    if color:
        total = np.maximum(pixels.sum(axis=1), 0.06)
        chroma = pixels / total[:, None]
        for channel in (0, 2):
            parts.extend(np.quantile(chroma[:, channel], [0.10, 0.5, 0.9]))
        maximum, minimum = pixels.max(axis=1), pixels.min(axis=1)
        saturation = (maximum - minimum) / np.maximum(maximum, 1e-6)
        parts.extend(np.quantile(saturation, [0.25, 0.5, 0.9]) * 0.5)
    if not parts:
        raise ValueError("请至少选择色彩或影调匹配")
    return np.array(parts, dtype=np.float64)


def feature_distance(a, b):
    return float(np.sqrt(np.mean(np.square(a - b))))


def _display(image, params):
    from photo.color_management import display_rgb
    return display_rgb(image, params.get("base_photo_style", "STD"))


def match_reference(image, reference, params, context=None, *, color=True, tone=True, strength=0.7):
    """返回未应用候选；最终距离与风险用实际 33³ LUT 重新测量。"""
    if not isinstance(strength, (float, int)) or isinstance(strength, bool) or not 0 <= strength <= 1:
        raise ValueError("匹配强度必须在 0 到 1")
    ctx = normalize_context(context)
    before = deepcopy(params)
    for field in ("gain", "gamma", "lift"):
        before[field] = list(before[field])
    source = S.downsample(image, 96)
    target = matching_features(S.downsample(reference, 96), color=color, tone=tone)

    def measure(candidate, size=17):
        pixels = R.render_lut(R.lut_from_params(candidate, size=size), source)
        return feature_distance(matching_features(_display(pixels, candidate), color=color, tone=tone), target)

    distance_before = measure(before, 33)
    best = deepcopy(before)
    best_distance = measure(best)
    coordinates = [item for item in COORDINATES if item[0] not in ctx.locked_fields
                   and ((item[3] == "color" and color) or (item[3] == "tone" and tone))]
    if strength > 0:
        for scale in (1.0, 0.5, 0.25):
            for field, channel, step, _ in coordinates:
                for sign in (-1, 1):
                    candidate = deepcopy(best)
                    if channel is None:
                        candidate[field] += sign * step * scale
                    else:
                        candidate[field][channel] += sign * step * scale
                    bounded = lut_params_from_dict(candidate)
                    value = getattr(bounded, field)
                    if (list(value) if isinstance(value, tuple) else value) != candidate[field]:
                        continue
                    if application_reasons(before, candidate, ctx, "style"):
                        continue
                    distance = measure(candidate)
                    if distance < best_distance - 1e-7:
                        best, best_distance = candidate, distance

    candidate = deepcopy(before)
    for field, channel, _, _ in coordinates:
        if channel is None:
            candidate[field] = before[field] + strength * (best[field] - before[field])
        else:
            candidate[field][channel] = before[field][channel] + strength * (best[field][channel] - before[field][channel])
    risk_image = S.downsample(image, S.MAX_ANALYZE_SIDE)
    rendered_before = R.render_lut(R.lut_from_params(before), risk_image)
    skin = S.skin_mask_of(rendered_before)
    measured_before = S.analyze(rendered_before, skin_mask=skin)
    reasons = []
    from agent.auto import check_hard_rules
    for _ in range(5):
        allowed, reasons = check_hard_rules(measured_before, candidate, measured_before,
                                           Q.limits_for(measured_before), before, risk_image, skin, ctx)
        if allowed and measure(candidate, 33) <= distance_before + 1e-9:
            break
        for field, channel, _, _ in coordinates:
            if channel is None:
                candidate[field] = before[field] + (candidate[field] - before[field]) * 0.5
            else:
                candidate[field][channel] = before[field][channel] + (candidate[field][channel] - before[field][channel]) * 0.5
    else:
        candidate = deepcopy(before)
    distance_after = measure(candidate, 33)
    if distance_after >= distance_before - 1e-7:
        candidate, distance_after = deepcopy(before), distance_before
    changed = [field for field in before if before[field] != candidate[field]]
    warnings = ["统计接近不代表艺术效果一致；场景构成和光照差异会影响匹配。"]
    if not coordinates:
        warnings.append("选中的匹配参数均受保护，本次没有可写调整项。")
    elif not changed:
        warnings.append("未找到在现有参数和风险约束内更接近参考的候选，保留当前效果。")
    if reasons:
        warnings.append("候选已按图像风险约束减弱或保留原效果。")
    return {"version": MATCH_VERSION, "before_params": before, "params": candidate,
            "changed_fields": changed, "distance_before": distance_before, "distance_after": distance_after,
            "improvement_pct": max(0.0, (distance_before - distance_after) / max(distance_before, 1e-9) * 100),
            "warnings": warnings, "color": bool(color), "tone": bool(tone), "strength": float(strength),
            "model_called": False}
