"""自动修图编排:测量 → 判定 → 提议 → 硬校验 → 风格 → 视觉复检。

设计原则:**用眼睛看的是代码,用脑子想的是模型。**
模型不直接猜参数后盲发,而是基于客观测量给出靶向修正;每一轮提议都要过一道与
模型无关的确定性硬校验,不合格就回退重提,再不达标就用可计算的保守解兜底并如实告知。

这一层是唯一把「测量」「LLM」「引擎」缝在一起的地方,但**不碰 HTTP**。
"""
import json
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

from lut_engine import LutParams, lut_params_from_dict

from photo import quality as Q
from photo import render as R
from photo import stats as S
from photo.types import AutoGradeResult, Issue, PhotoStats, StepReport
from .editing import (application_reasons, context_prompt, normalize_context,
                      parameter_snapshot, writable_fields)

MAX_OPTIMIZE_ROUNDS = 2
MAX_STYLE_ROUNDS = 2
# 单次自动修图最多产出几轮 —— 防止 LLM 反复给出被拒提议时打转
MAX_TOTAL_STEPS = 6

# 保守解限幅:只做高置信度修正,幅度必须小
CONSERVATIVE_MAX_EXPOSURE_EV = 0.6

# 温标增益(实测标定):深色温轨道的效果是**非线性**的 ——
# 实测在 B−R=−0.222 的图上,−3000K 只把 B−R 拉回 +0.053。
# 即 ±3000K 全行程约能修正 0.05 的全局色偏,所以:
#   - 轻度偏色(<0.05)一轮即可
#   - 中度偏色靠多轮叠加(每轮预算 1200K)
# 这个增益是「每单位 B−R 需要多少 K」,按实测 ≈ 800/0.011 ≈ 实测斜率换算。
CONSERVATIVE_TEMP_GAIN_PER_UNIT = 3800.0
CONSERVATIVE_TEMP_BUDGET_K = 1200.0

# 不参与自动调整的字段(决定 LUT 输入侧,必须只读透传)
READONLY_FIELDS = ("base_photo_style", "tone_map", "curve_points", "external_lut_id", "external_lut_strength", "external_lut_mode")


class AutoGradeCancelled(Exception):
    """调用方已取消；当前候选不得被应用或保存。"""


def _check_cancelled(cancel_check):
    if cancel_check is not None and cancel_check():
        raise AutoGradeCancelled()


# --------------------------------------------------------------------------
# 参数合并与限幅
# --------------------------------------------------------------------------

def merge_params(base: Dict[str, Any], delta: Dict[str, Any]) -> Dict[str, Any]:
    """增量叠加。标量相加,三通道数组逐项相加,其余覆盖。"""
    out = dict(base)
    for key, value in delta.items():
        if key in READONLY_FIELDS:
            continue                      # 只读字段不接受增量
        if isinstance(value, (list, tuple)) and isinstance(out.get(key), (list, tuple)):
            out[key] = [a + b for a, b in zip(out[key], value)]
        elif isinstance(value, (int, float)) and isinstance(out.get(key), (int, float)):
            out[key] = out[key] + value
        else:
            out[key] = value
    return out


def style_targets_to_delta(current: Dict[str, Any], targets: Dict[str, Any]) -> Dict[str, Any]:
    """风格提取器给的是绝对参数；转成合并器需要的增量。"""
    delta = {}
    for key, value in targets.items():
        if key in READONLY_FIELDS or key == "intent" or value is None or key not in current:
            continue
        old = current[key]
        if isinstance(value, (list, tuple)) and isinstance(old, (list, tuple)):
            if len(value) == len(old):
                delta[key] = [v - o for v, o in zip(value, old)]
        elif isinstance(value, (int, float)) and isinstance(old, (int, float)):
            delta[key] = value - old
    return delta


def clamp_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """过一遍 LutParams 的 clamp,保证落到合法区间。

    直接复用引擎的 clamp,而不是在编排层重写一套 —— 两套限幅必然漂移。
    """
    merged = {**params}
    for key in READONLY_FIELDS:
        merged.pop(key, None)
    clamped = lut_params_from_dict(merged)
    out = {f: getattr(clamped, f) for f in LutParams.__dataclass_fields__}
    for key in ("lift", "gamma", "gain"):
        out[key] = list(out[key])
    # 只读字段原样回填
    for key in READONLY_FIELDS:
        if key in params:
            out[key] = parameter_snapshot({key:params[key]})[key]
    return out


# --------------------------------------------------------------------------
# 硬校验:与模型无关的确定性闸门
# --------------------------------------------------------------------------

def check_hard_rules(
    stats_before: PhotoStats,
    candidate: Dict[str, Any],
    stats_baseline: PhotoStats,
    limits: Dict[str, float],
    base_params: Dict[str, Any],
    img: np.ndarray,
    skin_mask: Optional[np.ndarray] = None,
    context: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, List[str]]:
    """候选参数是否可接受。返回 (是否通过, 拒绝原因列表)。

    规则对比的基准有两类,**不能混用**:
      - R1/R2(裁剪)对比 **紧邻的上一轮**:防某一轮突然造成溢出
      - R4(饱和度)对比 **最初基线**:防多轮累加逐步把饱和度推上天
    混用会让 R4 被逐轮绕过。

    `skin_mask` 必须是**从基线图取的**那一个:肤色判定依赖 YCbCr 阈值,而 LUT 会
    改颜色,每轮重算掩码等于每轮换一批像素充当「皮肤」,偏移量会虚高数倍
    (实测色温 -800K 真实移 0.031,重算掩码后报 0.138 → 安全的修正被误拒)。
    """
    reasons: List[str] = []

    # R6:全部参数必须在合法区间内(clamp 前后是否一致)
    if clamp_params(candidate) != candidate:
        # LutParams 的 clamp 会修正越界值 —— 出现差异说明提议越界
        fixed = clamp_params(candidate)
        for key, value in candidate.items():
            if key in READONLY_FIELDS:
                continue
            if fixed.get(key) != value:
                reasons.append(f"参数 {key} 超出允许范围")
    if reasons:
        return False, reasons

    after = S.analyze(R.render_lut(R.lut_from_params(candidate), img), skin_mask)

    # R1 / R2:裁剪不得显著增加
    clip_up = after.highlight_clip_pct - stats_before.highlight_clip_pct
    if clip_up > Q.MAX_CLIP_INCREASE_PCT:
        reasons.append(
            f"高光溢出从 {stats_before.highlight_clip_pct:.2f}% 增到 "
            f"{after.highlight_clip_pct:.2f}%,超出允许范围"
        )
    dark_up = after.shadow_clip_pct - stats_before.shadow_clip_pct
    if dark_up > Q.MAX_CLIP_INCREASE_PCT:
        reasons.append(
            f"阴影压死比例从 {stats_before.shadow_clip_pct:.2f}% 增到 "
            f"{after.shadow_clip_pct:.2f}%"
        )

    # R3:肤色保护(仅在有可测肤色时)。两个亮度无关的指标,详见 quality.skin_shift:
    # 色相/饱和度用严格阈值(真把肤色调坏了),明度用宽松阈值(只挡洗白/压死)。
    if (normalize_context(context).subject_mode == "portrait"
            and stats_baseline.skin_ratio > 0.02 and stats_baseline.skin_mean_rgb is not None):
        chroma, luma = Q.skin_shift(stats_baseline, after)
        if chroma > Q.SKIN_CHROMA_LIMIT:
            reasons.append(
                f"肤色色相或饱和度偏移过大({chroma:.3f},上限 {Q.SKIN_CHROMA_LIMIT})"
            )
        if luma > Q.SKIN_LUMA_LIMIT:
            reasons.append(f"肤色明度漂移过大({luma:.3f},上限 {Q.SKIN_LUMA_LIMIT})")

    # R4:饱和度相对**最初基线**的倍率(防逐轮累加绕过)
    if stats_baseline.saturation_mean > 1e-6:
        growth = after.saturation_mean / stats_baseline.saturation_mean
        if growth > Q.MAX_SATURATION_GROWTH:
            reasons.append(
                f"饱和度会升到基线的 {growth:.2f} 倍"
                f"(上限 {Q.MAX_SATURATION_GROWTH}),画面会失真"
            )

    # R5:单轮曝光步长
    exp_delta = abs(candidate.get("exposure", 0.0) - base_params.get("exposure", 0.0))
    if exp_delta > Q.MAX_EXPOSURE_STEP_EV:
        reasons.append(
            f"单次曝光调整 {exp_delta:.1f} EV 超过上限 {Q.MAX_EXPOSURE_STEP_EV:.1f} EV,过于激进"
        )

    # R7:噪点高时限制对比度/饱和度增幅
    noise = stats_baseline.noise_sigma
    if noise > Q.NOISE_SIGMA_WARN:
        c_delta = abs(candidate.get("contrast", 0.0) - base_params.get("contrast", 0.0))
        if c_delta > limits["max_contrast_delta"]:
            reasons.append(
                f"照片噪点较高(sigma={noise:.3f}),对比度增量 {c_delta:.2f} "
                f"超过上限 {limits['max_contrast_delta']:.2f}"
            )
        s_delta = abs(candidate.get("saturation", 0.0) - base_params.get("saturation", 0.0))
        if s_delta > limits["max_saturation_delta"]:
            reasons.append(
                f"照片噪点较高,饱和度增量 {s_delta:.2f} "
                f"超过上限 {limits['max_saturation_delta']:.2f}"
            )

    return (not reasons), reasons


# --------------------------------------------------------------------------
# 保守解:不依赖 LLM 的兜底
# --------------------------------------------------------------------------

def conservative_iterative(img: np.ndarray, base: Dict[str, Any],
                           max_rounds: int = 4,
                           stats_baseline: Optional[PhotoStats] = None,
                           skin_mask: Optional[np.ndarray] = None,
                           budget_origin: Optional[Dict[str, Any]] = None,
                           context: Optional[Dict[str, Any]] = None,
                           blocked_reasons: Optional[List[str]] = None,
                           cancel_check: Optional[Callable[[], bool]] = None) -> Tuple[Dict[str, Any], PhotoStats]:
    """迭代保守解:每轮重测,直到收敛或用尽轮数。

    为什么需要迭代:温标单轮预算 1200K 只能修正约 0.01 的全局色偏,
    而中度偏色可达 0.10~0.20 —— 单轮远远不够。迭代是「用可计算的手段
    逐步逼近」,仍然不需要模型。

    每轮都重新测量,所以不会过冲:接近目标时公式给出的增量自然变小。

    **守卫:只接受「问题数不增加」的迭代。** 保守解是启发式,可能在修一个问题的同时
    制造另一个(实测:一张偏暗且暗部偏蓝的图,全局暖化会新增「整体偏暖」)。
    没有这道守卫就会越修越糟 —— 兜底路径尤其不能这样。

    stats_baseline 用于限幅(见 conservative_solution);不传则用当前图的测量。
    """
    _check_cancelled(cancel_check)
    params = clamp_params(dict(base))
    ctx = normalize_context(context)
    stats = S.analyze(R.render_lut(R.lut_from_params(params), img), skin_mask)
    baseline = stats_baseline if stats_baseline is not None else stats
    best_params, best_stats = params, stats
    best_count = len(Q.diagnose_for_goal(stats, ctx.goal_mode))
    if best_count == 0 or not writable_fields(ctx, "rules"):
        return best_params, best_stats

    for _ in range(max_rounds):
        _check_cancelled(cancel_check)
        candidate = conservative_solution(best_stats, best_params, stats_ref=baseline,
                                          budget_origin=budget_origin, context=ctx)
        if candidate == best_params:
            break
        reasons = application_reasons(params, candidate, ctx, "rules")
        if not reasons:
            _, reasons = check_hard_rules(best_stats, candidate, baseline, Q.limits_for(baseline),
                                          best_params, img, skin_mask, ctx)
        if reasons:
            if blocked_reasons is not None:
                blocked_reasons.extend(reasons)
            break
        cand_stats = S.analyze(R.render_lut(R.lut_from_params(candidate), img), skin_mask)
        _check_cancelled(cancel_check)
        cand_count = len(Q.diagnose_for_goal(cand_stats, ctx.goal_mode))
        if cand_count > best_count:
            break                      # 这一步会制造新问题,停下并保留当前最好结果
        best_params, best_stats, best_count = candidate, cand_stats, cand_count
        if best_count == 0:
            break
    return best_params, best_stats


def conservative_solution(stats: PhotoStats, base: Dict[str, Any],
                          temp_budget_k: float = CONSERVATIVE_TEMP_BUDGET_K,
                          stats_ref: Optional[PhotoStats] = None,
                          budget_origin: Optional[Dict[str, Any]] = None,
                          context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """只做高置信度修正:曝光拉向目标区间中点 + 灰世界白平衡。

    曝光与白平衡的修正是**可计算的**(相机自动测光就是同一原理),不需要模型判断。
    弱化模型让不确定性下降,同时保证有产出 —— 这是「不返回坏结果」的兜底。

    temp_budget_k 是单轮允许的色温修正上限(绝对值)。编排层可以按剩余预算传更小的值。

    `stats` 是**当前测量**(用于算出还差多少),`stats_ref` 是**限幅基准**(默认等于 stats)。
    两者分开是必要的:兜底时 `base` 里可能已经有 LLM 加过的曝光,若仍按 `stats` 全额补差,
    就会与「曝光相对基线不超过 1EV」的硬校验规则冲突,导致累计曝光被放大。
    传入最初的 stats0 作为 stats_ref,增量就被限制在相对基线的安全带内。
    """
    ref = stats_ref if stats_ref is not None else stats
    params = dict(base)
    allowed = writable_fields(context, "rules")
    if not allowed:
        return clamp_params(params)
    origin = budget_origin or {}
    lo, hi = Q.EXPOSURE_TARGET
    target = (lo + hi) / 2.0
    if "exposure" in allowed and stats.lum_p50 > 1e-6:
        # p50 与线性域的曝光大致满足 p50' ≈ p50 * 2^ev → ev = log2(target/p50)
        ev = float(np.log2(max(target, 1e-6) / max(stats.lum_p50, 1e-6)) * 0.8)
        ev = float(np.clip(ev, -CONSERVATIVE_MAX_EXPOSURE_EV, CONSERVATIVE_MAX_EXPOSURE_EV))
        # 限幅相对**基线**:已应用的曝光也算在这笔预算里
        low = origin.get("exposure", 0.0) - CONSERVATIVE_MAX_EXPOSURE_EV
        high = origin.get("exposure", 0.0) + CONSERVATIVE_MAX_EXPOSURE_EV
        ev = float(np.clip(params.get("exposure", 0.0) + ev, low, high)) - params.get("exposure", 0.0)
        params["exposure"] = params.get("exposure", 0.0) + ev

    b_minus_r = stats.rgb_mean[2] - stats.rgb_mean[0]
    if "temp" in allowed and abs(b_minus_r) > Q.CAST_MIN_GLOBAL and stats.gray_world_dev > Q.GRAY_WORLD_WARN:
        # 符号:**正 temp = 更暖**(已实测确认),所以偏暖(B−R<0)必须给负 temp 降温。
        # 早期版本写成 +b_minus_r,把「更暖」当成修正,方向完全反了。
        k = (ref.rgb_mean[2] - ref.rgb_mean[0]) * CONSERVATIVE_TEMP_GAIN_PER_UNIT
        budget = abs(temp_budget_k)
        # 限幅相对基线:已应用的色温也算在这笔预算里
        low = origin.get("temp", 0.0) - budget
        high = origin.get("temp", 0.0) + budget
        k = float(np.clip(params.get("temp", 0.0) + k, low, high)) - params.get("temp", 0.0)
        params["temp"] = params.get("temp", 0.0) + k

    return clamp_params(params)


# --------------------------------------------------------------------------
# LLM 交互
# --------------------------------------------------------------------------

CORRECTION_SYSTEM_PROMPT = (
    "你是专业修图师。根据照片的客观统计与已诊断的问题,给出 LUT 调色的**增量**修正。\n"
    "规则:\n"
    "1. 只对你判断有问题的地方给增量;判断没问题的参数一律留空。\n"
    "2. 增量幅度要克制:单轮曝光不超过 ±1 EV,对比度/饱和度不超过 ±0.5。\n"
    "3. 相对调整基于「当前参数」,不要覆盖未被提及的参数。\n"
    "4. 如果给了「上一轮被拒原因」,不要重复同样的提议。\n"
    "5. 只能使用 propose_correction 的 schema 中已有字段及合法范围,不能扩展创意参数;"
    "不要输出 LUT 不支持的调整,例如清晰度、降噪、锐化、颗粒、暗角或空间局部蒙版。\n"
    "6. RGB 参数也返回逐通道增量,中性增量为 0,不是绝对目标值 1。\n"
    "7. diagnosis 仅诊断影调与色彩,不要声称执行了 LUT 不支持的操作。\n"
    "8. 只通过 propose_correction 工具返回结果,不要输出解释文字。"
)


def _correction_prompt(stats: PhotoStats, issues: List[Issue], params: Dict[str, Any],
                       rejections: List[str], context: Optional[Dict[str, Any]] = None) -> str:
    parts = [context_prompt(context, "correction"),
             f"照片统计:{json.dumps(S.to_prompt_dict(stats), ensure_ascii=False)}"]
    if issues:
        parts.append("诊断出的问题:")
        parts.extend(f"  - {i.evidence}" for i in issues)
    parts.append(f"当前参数:{json.dumps(params, ensure_ascii=False)}")
    if rejections:
        parts.append("上一轮被拒原因(不要重复):")
        parts.extend(f"  - {r}" for r in rejections)
    return "\n".join(parts)


def propose_correction(
    client: Any,
    stats: PhotoStats,
    issues: List[Issue],
    params: Dict[str, Any],
    rejections: Optional[List[str]] = None,
    model: Optional[str] = None,
    max_tokens: int = 2000,
    *,
    context: Optional[Dict[str, Any]] = None,
) -> Tuple[Dict[str, Any], str, Dict[str, Any]]:
    """让模型给出增量提议。返回 (增量字典, 诊断原话, usage)。

    取不到有效提议时返回空增量 —— 调用方按「模型放弃」处理。
    """
    from .schemas import CORRECTION_TOOL_NAME, CorrectionProposal, build_correction_tool

    if not writable_fields(context, "correction"):
        return {}, "", {}
    resp = client.chat.completions.create(
        model=model or _default_model(),
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": CORRECTION_SYSTEM_PROMPT},
            {"role": "user", "content": _correction_prompt(stats, issues, params, rejections or [], context)},
        ],
        tools=[build_correction_tool()],
    )
    usage = resp.usage.model_dump() if getattr(resp, "usage", None) else {}
    choice = resp.choices[0] if resp.choices else None
    if choice is None:
        return {}, "", usage
    calls = getattr(choice.message, "tool_calls", None)
    if not calls:
        return {}, "", usage
    try:
        if calls[0].function.name != CORRECTION_TOOL_NAME:
            return {}, "", usage
        raw = json.loads(calls[0].function.arguments)
    except (json.JSONDecodeError, TypeError, AttributeError, IndexError):
        return {}, "", usage
    if not isinstance(raw, dict):
        return {}, "", usage
    try:
        proposal = CorrectionProposal.model_validate(raw)
    except Exception:
        return {}, "", usage
    return proposal.deltas(), proposal.diagnosis, usage


def _default_model() -> str:
    import os
    return os.environ.get("CHROMA_LLM_MODEL", "deepseek-flash")


# --------------------------------------------------------------------------
# 视觉复检
# --------------------------------------------------------------------------

VISION_REVIEW_PROMPT = (
    "这组图:左边是原图,右边是套用 LUT 后的结果。"
    "请仅评价影调与色彩是否改善,还有什么问题?用 2-4 句话说明。"
    "建议只限现有 LUT 调整项:曝光、冷暖与绿洋红、对比与影调分区、"
    "饱和度与色相、按色相选色、RGB 三通道与分离色调。"
    "禁止建议或声称执行锐化、降噪、颗粒、磨皮、清晰度、暗角或空间局部调整。"
    "**不要给出参数数值** —— 只做主观评价。"
)


def vision_review(client: Any, before: np.ndarray, after: np.ndarray,
                  style: Optional[str] = None,
                  model: Optional[str] = None, max_tokens: int = 1200,
                  *, context: Optional[Dict[str, Any]] = None,
                  base_photo_style: str = "STD",
                  ) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
    """把调整前后已渲染的编码 RGB 转到 sRGB 后发给模型做主观复检。

    返回 (意见, usage, 未完成原因):
      None      复检返回有效意见
      "unchanged" 实际效果未变化,不评价前后改善
      "empty"   模型未返回有效文字
      "failed"  调用失败(模型/网络)
      "no_client" 未配置客户端

    复检是**增强能力**:它失败不能导致整个自动修图失败,所以这里吞掉异常。
    但**必须把失败原因传出去** —— 否则前端只能显示「已关闭视觉复核」,
    用户会以为是自己关的。
    """
    if client is None:
        return None, {}, "no_client"
    if np.array_equal(before, after):
        return None, {}, "unchanged"
    try:
        from photo.color_management import display_rgb
        before_display = display_rgb(before, base_photo_style)
        after_display = display_rgb(after, base_photo_style)
        if np.array_equal(R.quantize_rgb8(before_display), R.quantize_rgb8(after_display)):
            return None, {}, "unchanged"
        panel = R.side_by_side(before_display, after_display)
        url = R.to_data_url(panel)
        text = VISION_REVIEW_PROMPT.replace("左边是原图", "左边是本次调整前的效果") + "\n" + context_prompt(context, "review")
        if style:
            text += f"\n(用户指定的风格是「{style}」,请一并判断是否贴合)"
        resp = client.chat.completions.create(
            model=model or _default_model(),
            max_tokens=max_tokens,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": url, "detail": "low"}},
                ],
            }],
        )
        usage = resp.usage.model_dump() if getattr(resp, "usage", None) else {}
        content = resp.choices[0].message.content if resp.choices else None
        opinion = content.strip() if isinstance(content, str) else ""
        return opinion or None, usage, None if opinion else "empty"
    except AutoGradeCancelled:
        raise
    except Exception:
        return None, {}, "failed"


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def auto_grade(
    img: np.ndarray,
    base_params: Dict[str, Any],
    style: Optional[str] = None,
    client: Any = None,
    *,
    use_vision: bool = True,
    max_rounds: int = MAX_OPTIMIZE_ROUNDS,
    style_extractor: Optional[Callable[[Any, str, Dict[str, Any]], Dict[str, Any]]] = None,
    proposer: Optional[Callable[..., Tuple[Dict[str, Any], str, Dict[str, Any]]]] = None,
    context: Optional[Dict[str, Any]] = None,
    progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    resume: Optional[Dict[str, Any]] = None,
) -> AutoGradeResult:
    """基于当前参数执行目标允许的校正与风格,每个候选整体校验。

    style_extractor 接收客户端、风格描述和当前参数,返回绝对目标值。
    proposer 可注入提议,上下文与硬校验仍由编排层执行。
    缺省上下文沿用自然校正;阶段来源保存真实生效的前后参数。
    """
    from .schemas import ExtractResult

    def notify(stage, state, round_no=0, reason=None):
        _check_cancelled(cancel_check)
        if progress is not None:
            progress({"stage": stage, "state": state, "round": round_no,
                      **({"reason": reason} if reason else {})})
        _check_cancelled(cancel_check)

    notify("measure", "running")
    ctx = normalize_context(context)
    resume = resume or {}
    skip_correction = bool(resume.get("skip_correction"))
    skip_style = bool(resume.get("skip_style"))
    base = clamp_params(parameter_snapshot(base_params))
    baseline_img = R.render_lut(R.lut_from_params(base), img)
    skin_mask = S.skin_mask_of(baseline_img)
    stats0 = S.analyze(baseline_img, skin_mask)
    observations = Q.diagnose(stats0)
    issues = Q.diagnose_for_goal(stats0, ctx.goal_mode)
    limits = Q.limits_for(stats0)
    notify("measure", "done")
    params = parameter_snapshot(base)
    stats_current = stats0
    steps: List[StepReport] = []
    blocked: List[str] = list(resume.get("blocked_reasons") or [])
    rejections: List[str] = []
    usage_total: Dict[str, Any] = {}
    model_attempted = False
    model_succeeded = False
    model_failed = False
    rules_applied = False

    def report(stage, round_no, diagnosis, proposed=None, applied=False,
               reasons=None, before=None):
        snapshot = parameter_snapshot(before if before is not None else params)
        steps.append(StepReport(
            stage=stage, round=round_no, diagnosis=diagnosis, proposed=proposed or {},
            applied=applied, rejections=list(reasons or []),
            stats_after=stats_current if applied else None,
            params_before=snapshot, params_after=parameter_snapshot(params),
            purpose="style" if stage == "style" else "correction",
        ))

    can_correct = bool(writable_fields(ctx, "correction"))
    if issues and ctx.goal_mode != "style_only" and not can_correct:
        blocked.append("基础校正的可调参数全部已锁定")
    if client is not None and issues and can_correct and not skip_correction:
        for round_no in range(1, max_rounds + 1):
            if len(steps) >= MAX_TOTAL_STEPS:
                break
            model_attempted = True
            notify("optimize", "running", round_no)
            try:
                if proposer is None:
                    delta, diagnosis, usage = propose_correction(
                        client, stats_current, Q.diagnose_for_goal(stats_current, ctx.goal_mode),
                        parameter_snapshot(params), rejections, context=ctx)
                else:
                    delta, diagnosis, usage = proposer(
                        client, stats_current, Q.diagnose_for_goal(stats_current, ctx.goal_mode),
                        parameter_snapshot(params), list(rejections))
                model_succeeded = True
            except AutoGradeCancelled:
                raise
            except Exception as exc:
                _check_cancelled(cancel_check)
                model_failed = True
                reason = f"模型调用失败({type(exc).__name__})"
                blocked.append(reason)
                report("optimize", round_no, reason)
                break
            _check_cancelled(cancel_check)
            _accumulate_usage(usage_total, usage)
            if not delta:
                report("optimize", round_no, "模型未给出有效提议")
                break
            before = parameter_snapshot(params)
            candidate = merge_params(params, delta)
            reasons = application_reasons(base, candidate, ctx, "correction")
            if not reasons:
                _, reasons = check_hard_rules(stats_current, candidate, stats0, limits, params,
                                              img, skin_mask, ctx)
            if reasons:
                rejections.extend(reasons)
                blocked.extend(reasons)
                report("optimize", round_no, diagnosis, delta, reasons=reasons, before=before)
                continue
            params = clamp_params(candidate)
            stats_current = S.analyze(R.render_lut(R.lut_from_params(params), img), skin_mask)
            report("optimize", round_no, diagnosis, delta, params != before, before=before)
            if Q.is_goal_met(stats_current, ctx.goal_mode):
                break
        correction_steps = [step for step in steps if step.stage == "optimize"]
        notify("optimize", "done", reason=None if any(step.applied for step in correction_steps)
               else "failed" if model_failed else "blocked" if rejections else "unchanged")
    else:
        notify("optimize", "skipped", reason=("continued" if skip_correction else "goal" if ctx.goal_mode == "style_only"
               else "locked" if not can_correct else "no_issues" if not issues else "no_client"))

    style_params = None
    style_applied = False
    style_applied_params = None
    style_rejections: List[str] = list(resume.get("style_rejections") or [])
    can_style = bool(writable_fields(ctx, "style"))
    if ctx.goal_mode == "style_only" and not style:
        blocked.append("只调整风格模式需要提供风格描述")
    if style and not can_style:
        blocked.append("风格阶段的可调参数全部已锁定")
    if style and client is not None and style_extractor is not None and can_style and not skip_style:
        for round_no in range(1, MAX_STYLE_ROUNDS + 1):
            if len(steps) >= MAX_TOTAL_STEPS:
                break
            model_attempted = True
            notify("style", "running", round_no)
            text = style
            if style_rejections:
                text += "\n上一轮未应用的原因:" + ";".join(style_rejections) + "。请重新提出合法目标。"
            try:
                extracted = dict(style_extractor(client, text, parameter_snapshot(params)) or {})
                if not extracted:
                    report("style", round_no, "模型未给出有效风格提议")
                    break
                extracted = ExtractResult.model_validate(
                    {"intent": "describe", **extracted}).model_dump(exclude_none=True)
                extracted.pop("intent", None)
                model_succeeded = True
            except AutoGradeCancelled:
                raise
            except Exception as exc:
                _check_cancelled(cancel_check)
                model_failed = True
                reason = f"风格提取失败({type(exc).__name__})"
                style_rejections = [reason]
                blocked.append(reason)
                report("style", round_no, reason, reasons=style_rejections)
                continue
            _check_cancelled(cancel_check)
            if not extracted:
                break
            style_params = {key: value for key, value in extracted.items()
                            if key not in READONLY_FIELDS}
            before = parameter_snapshot(params)
            candidate = {**params, **extracted}
            reasons = application_reasons(base, candidate, ctx, "style")
            if not reasons:
                _, reasons = check_hard_rules(stats_current, candidate, stats0, limits, params,
                                              img, skin_mask, ctx)
            if reasons:
                style_rejections = reasons
                blocked.extend(reasons)
                report("style", round_no, f"风格:{style}", style_params,
                       reasons=reasons, before=before)
                continue
            params = clamp_params(candidate)
            style_applied = True
            style_applied_params = dict(style_params)
            style_rejections = []
            stats_current = S.analyze(R.render_lut(R.lut_from_params(params), img), skin_mask)
            report("style", round_no, f"风格:{style}", style_params,
                   params != before, before=before)
            break
        style_steps = [step for step in steps if step.stage == "style"]
        notify("style", "done", reason=None if any(step.applied for step in style_steps)
               else "failed" if any("失败" in reason for reason in style_rejections)
               else "blocked" if style_rejections else "unchanged")
    else:
        notify("style", "skipped", reason="continued" if skip_style else "not_requested" if not style
               else "locked" if not can_style else "no_client")

    # 仅在没有生效提议时应用规则,避免在风格成果上再次补偿。
    needs_rules = not any(step.applied for step in steps) and not Q.is_goal_met(stats_current, ctx.goal_mode)
    if ctx.goal_mode == "natural" and needs_rules and not skip_correction:
        if writable_fields(ctx, "rules"):
            notify("rules", "running")
            before = parameter_snapshot(params)
            params, stats_current = conservative_iterative(
                img, params, stats_baseline=stats0, skin_mask=skin_mask,
                budget_origin=base, context=ctx, blocked_reasons=blocked,
                cancel_check=cancel_check)
            reasons = application_reasons(base, params, ctx, "rules")
            if reasons:
                blocked.extend(reasons)
                params = before
                stats_current = S.analyze(R.render_lut(R.lut_from_params(params), img), skin_mask)
            rules_applied = params != before
            if rules_applied:
                diagnosis = "未启用模型,采用规则化保守调整" if client is None else "模型提议未生效,采用规则化保守调整"
                report("optimize", 1 if client is None else 0, diagnosis, applied=True, before=before)
            notify("rules", "done", reason=None if rules_applied else "blocked" if reasons else "unchanged")
        elif set(ctx.locked_fields) & {"exposure", "temp"}:
            blocked.append("规则兜底的可调参数已锁定")
            notify("rules", "skipped", reason="locked")
        else:
            notify("rules", "skipped", reason="no_writable_fields")
    else:
        notify("rules", "skipped", reason="continued" if skip_correction else "goal" if ctx.goal_mode != "natural" else "not_needed")

    review = None
    review_skip_reason = None
    if client is None:
        review_skip_reason = "no_client"
    elif not use_vision:
        review_skip_reason = "disabled"
    elif ctx.goal_mode == "style_only" and not style:
        review_skip_reason = "not_requested"
    elif not can_correct and not (style and can_style):
        review_skip_reason = "locked"
    elif params == base:
        review_skip_reason = "unchanged"
    else:
        notify("review", "running")
        after_img = R.render_lut(R.lut_from_params(params), img)
        review, usage, review_skip_reason = vision_review(
            client, baseline_img, after_img, style=style, context=ctx,
            base_photo_style=params["base_photo_style"])
        _accumulate_usage(usage_total, usage)
        if review_skip_reason is None:
            notify("review", "done")
    if review_skip_reason:
        notify("review", "skipped", reason=review_skip_reason)

    changed = params != base
    inherited_targets = resume.get("completed_style_targets") or {}
    style_target_met = style_applied or (skip_style and bool(inherited_targets)
                       and all(params.get(key) == value for key, value in inherited_targets.items()))
    if ctx.goal_mode == "style_only":
        goal_status = "met" if style_target_met else "unchanged" if style else "not_evaluated"
    elif Q.is_goal_met(stats_current, ctx.goal_mode) and (not style or style_target_met):
        goal_status = "met"
    else:
        goal_status = "partially_met" if changed else "unchanged"
    if rules_applied:
        execution_status = "rules_only"
    elif model_succeeded:
        execution_status = "model"
    elif model_failed:
        execution_status = "failed"
    elif model_attempted:
        execution_status = "model"
    else:
        execution_status = "skipped"
    _check_cancelled(cancel_check)
    return AutoGradeResult(
        params=params, steps=steps, issues=issues, observations=observations,
        style_params=style_params, style_applied=style_applied,
        style_applied_params=style_applied_params, style_rejections=style_rejections,
        review=review, review_skip_reason=review_skip_reason,
        subject_protection={"subject_mode": ctx.subject_mode,
                            "enabled": ctx.subject_mode == "portrait" and stats0.skin_ratio > 0.02
                                       and stats0.skin_mean_rgb is not None,
                            "suspected_skin_ratio": stats0.skin_ratio, "method": "color_heuristic"},
        degraded=goal_status in {"partially_met", "unchanged"}, usage=usage_total,
        goal_status=goal_status, execution_status=execution_status,
        blocked_reasons=list(dict.fromkeys(blocked)),
    )


def _accumulate_usage(total: Dict[str, Any], part: Dict[str, Any]) -> None:
    for key, value in (part or {}).items():
        if isinstance(value, (int, float)):
            total[key] = total.get(key, 0) + value
