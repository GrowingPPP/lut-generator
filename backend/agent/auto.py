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

MAX_OPTIMIZE_ROUNDS = 2
MAX_STYLE_ROUNDS = 1
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
READONLY_FIELDS = ("base_photo_style", "tone_map")


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
            out[key] = params[key]
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
    if stats_baseline.skin_ratio > 0.02 and stats_baseline.skin_mean_rgb is not None:
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
                           skin_mask: Optional[np.ndarray] = None) -> Tuple[Dict[str, Any], PhotoStats]:
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
    params = clamp_params(dict(base))
    stats = S.analyze(img, skin_mask)
    baseline = stats_baseline if stats_baseline is not None else stats
    best_params, best_stats = params, stats
    best_count = len(Q.diagnose(stats))
    if best_count == 0:
        return best_params, best_stats

    for _ in range(max_rounds):
        candidate = conservative_solution(best_stats, best_params, stats_ref=baseline)
        if candidate == best_params:
            break
        cand_stats = S.analyze(R.render_lut(R.lut_from_params(candidate), img), skin_mask)
        cand_count = len(Q.diagnose(cand_stats))
        if cand_count > best_count:
            break                      # 这一步会制造新问题,停下并保留当前最好结果
        best_params, best_stats, best_count = candidate, cand_stats, cand_count
        if best_count == 0:
            break
    return best_params, best_stats


def conservative_solution(stats: PhotoStats, base: Dict[str, Any],
                          temp_budget_k: float = CONSERVATIVE_TEMP_BUDGET_K,
                          stats_ref: Optional[PhotoStats] = None) -> Dict[str, Any]:
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
    lo, hi = Q.EXPOSURE_TARGET
    target = (lo + hi) / 2.0
    if stats.lum_p50 > 1e-6:
        # p50 与线性域的曝光大致满足 p50' ≈ p50 * 2^ev → ev = log2(target/p50)
        ev = float(np.log2(max(target, 1e-6) / max(stats.lum_p50, 1e-6)) * 0.8)
        ev = float(np.clip(ev, -CONSERVATIVE_MAX_EXPOSURE_EV, CONSERVATIVE_MAX_EXPOSURE_EV))
        # 限幅相对**基线**:已应用的曝光也算在这笔预算里
        ev = float(np.clip(params.get("exposure", 0.0) + ev,
                           -CONSERVATIVE_MAX_EXPOSURE_EV,
                           CONSERVATIVE_MAX_EXPOSURE_EV)) - params.get("exposure", 0.0)
        params["exposure"] = params.get("exposure", 0.0) + ev

    b_minus_r = stats.rgb_mean[2] - stats.rgb_mean[0]
    if abs(b_minus_r) > Q.CAST_MIN_GLOBAL and stats.gray_world_dev > Q.GRAY_WORLD_WARN:
        # 符号:**正 temp = 更暖**(已实测确认),所以偏暖(B−R<0)必须给负 temp 降温。
        # 早期版本写成 +b_minus_r,把「更暖」当成修正,方向完全反了。
        k = (ref.rgb_mean[2] - ref.rgb_mean[0]) * CONSERVATIVE_TEMP_GAIN_PER_UNIT
        budget = abs(temp_budget_k)
        # 限幅相对基线:已应用的色温也算在这笔预算里
        k = float(np.clip(params.get("temp", 0.0) + k, -budget, budget)) - params.get("temp", 0.0)
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
    "5. 只通过 propose_correction 工具返回结果,不要输出解释文字。"
)


def _correction_prompt(stats: PhotoStats, issues: List[Issue], params: Dict[str, Any],
                       rejections: List[str]) -> str:
    parts = [f"照片统计:{json.dumps(S.to_prompt_dict(stats), ensure_ascii=False)}"]
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
) -> Tuple[Dict[str, Any], str, Dict[str, Any]]:
    """让模型给出增量提议。返回 (增量字典, 诊断原话, usage)。

    取不到有效提议时返回空增量 —— 调用方按「模型放弃」处理。
    """
    from .schemas import CORRECTION_TOOL_NAME, CorrectionProposal, build_correction_tool

    resp = client.chat.completions.create(
        model=model or _default_model(),
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": CORRECTION_SYSTEM_PROMPT},
            {"role": "user", "content": _correction_prompt(stats, issues, params, rejections or [])},
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
    "请判断修图是否改善了画面,还有什么问题?用 2-4 句话说明,"
    "**不要给出参数数值** —— 只做主观评价。"
)


def vision_review(client: Any, before: np.ndarray, after: np.ndarray,
                  style: Optional[str] = None,
                  model: Optional[str] = None, max_tokens: int = 1200
                  ) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
    """把原图与渲染图拼成一张发给模型做主观复检。

    返回 (意见, usage, 跳过原因)。跳过原因三选一:
      None      复检正常执行(可能仍返回空意见)
      "failed"  调用失败(模型/网络)
      "no_client" 未配置客户端

    复检是**增强能力**:它失败不能导致整个自动修图失败,所以这里吞掉异常。
    但**必须把失败原因传出去** —— 否则前端只能显示「已关闭视觉复核」,
    用户会以为是自己关的。
    """
    if client is None:
        return None, {}, "no_client"
    try:
        panel = R.side_by_side(before, after)
        url = R.to_data_url(panel)
        text = VISION_REVIEW_PROMPT
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
        return (content.strip() or None if isinstance(content, str) else None), usage, None
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
    style_extractor: Optional[Callable[[Any, str], Dict[str, Any]]] = None,
    proposer: Optional[Callable[..., Tuple[Dict[str, Any], str, Dict[str, Any]]]] = None,
) -> AutoGradeResult:
    """跑完整的自动修图。

    img: float32 HxWx3(0..1)
    base_params: 增量基准(前端传当前参数)
    style: 自然语言风格描述,None = 只优化
    client: LLM 客户端;为 None 时跳过所有 LLM 步骤(只用保守解)
    proposer: 可注入的提议函数(签名同 propose_correction),用于测试直接构造增量。

    注意「两道闸门」的区别,测试时要分清:
      - CorrectionProposal 的 schema 范围(如 exposure ±1)在**解析时**就拒掉越界提议,
        表现为「模型未给出有效提议」;
      - check_hard_rules 在**应用前**按图像实际效果拒绝,表现为 rejections 有内容。
    注入 proposer 可以绕过第一道,专门验证第二道。
    """
    base = clamp_params(dict(base_params))
    # 肤色掩码只在基线图上取一次,之后所有轮次共用 —— 否则「肤色偏移」测的是
    # 「这次哪些像素算皮肤」,而不是「同一个人被改了多少」。详见 check_hard_rules。
    skin_mask = S.skin_mask_of(img)
    stats0 = S.analyze(img, skin_mask)
    issues = Q.diagnose(stats0)
    limits = Q.limits_for(stats0)

    steps: List[StepReport] = []
    usage_total: Dict[str, Any] = {}
    params = dict(base)
    stats_current = stats0
    rejections: List[str] = []
    degraded = False

    # ---------- 阶段 A:优化 ----------
    if client is not None and issues:
        for round_no in range(1, max_rounds + 1):
            if len(steps) >= MAX_TOTAL_STEPS:
                break
            propose_fn = proposer or propose_correction
            try:
                delta, diagnosis, usage = propose_fn(
                    client, stats_current, Q.diagnose(stats_current), params, rejections)
            except Exception as exc:
                # LLM 中途失败(超时 / 预算耗尽 / 5xx)不能让整个请求崩:
                # 记录原因后退出优化循环,由下面的保守解兜底。
                steps.append(StepReport(stage="optimize", round=round_no,
                                        diagnosis=f"模型调用失败,已改用规则化保守调整({type(exc).__name__})",
                                        applied=False))
                break
            _accumulate_usage(usage_total, usage)
            if not delta:
                steps.append(StepReport(stage="optimize", round=round_no,
                                        diagnosis="模型未给出有效提议", applied=False))
                break

            candidate = clamp_params(merge_params(params, delta))
            ok, reasons = check_hard_rules(stats_current, candidate, stats0, limits, params,
                                           img, skin_mask)
            if not ok:
                rejections.extend(reasons)
                steps.append(StepReport(stage="optimize", round=round_no, diagnosis=diagnosis,
                                        proposed=delta, applied=False, rejections=reasons))
                continue

            params = candidate
            stats_current = S.analyze(R.render_lut(R.lut_from_params(params), img), skin_mask)
            steps.append(StepReport(stage="optimize", round=round_no, diagnosis=diagnosis,
                                    proposed=delta, applied=True, stats_after=stats_current))
            if Q.is_converged(stats_current):
                break

    elif issues:
        # 无 LLM:连提议都做不了,直接进入兜底(阶段 C)。这里不重复调用。
        pass

    # ---------- 阶段 B:风格 ----------
    style_params: Optional[Dict[str, Any]] = None
    style_applied = False
    style_applied_params: Optional[Dict[str, Any]] = None
    style_rejections: List[str] = []
    if style and client is not None and style_extractor is not None:
        try:
            extracted = style_extractor(client, style) or {}
        except Exception:
            extracted = {}
        extracted.pop("intent", None)
        if extracted:
            style_params = {k: v for k, v in extracted.items() if k not in READONLY_FIELDS}
            candidate = clamp_params(merge_params(params, style_params))
            # 风格**同样**要过硬校验 —— 否则「日系清透」会成为绕过后门的通道
            ok, reasons = check_hard_rules(stats_current, candidate, stats0, limits, params,
                                           img, skin_mask)
            if ok:
                params = candidate
                style_applied = True
                style_applied_params = dict(style_params)
                stats_current = S.analyze(R.render_lut(R.lut_from_params(params), img), skin_mask)
                steps.append(StepReport(stage="style", round=1,
                                        diagnosis=f"风格:{style}", proposed=style_params,
                                        applied=True, stats_after=stats_current))
            else:
                # 被拒时**不能**把提议当成结果:style_applied 保持 False、
                # style_applied_params 保持空,让前端如实呈现「没应用」。
                style_rejections = list(reasons)
                steps.append(StepReport(stage="style", round=1,
                                        diagnosis=f"风格:{style}", proposed=style_params,
                                        applied=False, rejections=reasons))

    # ---------- 阶段 C:兜底 ----------
    #
    # **必须放在所有阶段之后**。保守解自己就是一套完整的「曝光拉向目标 + 灰世界
    # 白平衡」修正,若在还有阶段没跑完时就启用,它会对同一个目标重复补偿。
    #
    # 这里踩过两次,都是同一种错的形状:
    #   1. 只看 optimize 阶段是否应用过 → 「优化全被拒 + 风格随后应用」时重复补偿
    #   2. 即使改成看全部 steps,只要兜底仍发生在**风格之前**,它看到的 steps 里
    #      就没有风格那一步 —— 实测风格给 exposure 0.15,兜底又加 0.6,最终 0.75,
    #      与「已应用 0.15」的标注自相矛盾。
    # 把兜底移到最后,`applied_any` 才真正反映「这一轮有没有人改过参数」。
    if client is None and issues:
        params, stats_current = conservative_iterative(
            img, base, stats_baseline=stats0, skin_mask=skin_mask)
        if params != base:
            steps.append(StepReport(stage="optimize", round=1,
                                    diagnosis="未启用模型,采用规则化保守调整",
                                    applied=True, stats_after=stats_current))
    elif not any(st.applied for st in steps) and not Q.is_converged(stats_current):
        params, stats_current = conservative_iterative(
            img, params, stats_baseline=stats0, skin_mask=skin_mask)
        if any(abs(params.get(k, 0) - base.get(k, 0)) > 1e-9
               for k in ("exposure", "temp") if isinstance(params.get(k), (int, float))):
            steps.append(StepReport(stage="optimize", round=0,
                                    diagnosis="模型提议均未通过校验,采用规则化保守调整",
                                    applied=True, stats_after=stats_current))
    degraded = not Q.is_converged(stats_current)

    # ---------- 视觉复检 ----------
    review: Optional[str] = None
    review_skip_reason: Optional[str] = None
    # 原因语义必须精确,顺序也有讲究:
    #   no_client 是「没配置模型」,disabled 是「用户主动关闭」—— 两者不能混,
    #   否则用户会以为是自己关的。所以先判 no_client,再判 use_vision。
    if client is None:
        review_skip_reason = "no_client"
    elif not use_vision:
        review_skip_reason = "disabled"
    else:
        after_img = R.render_lut(R.lut_from_params(params), img)
        review, usage, review_skip_reason = vision_review(client, img, after_img, style=style)
        _accumulate_usage(usage_total, usage)

    return AutoGradeResult(
        params=params,
        steps=steps,
        issues=issues,
        style_params=style_params,
        style_applied=style_applied,
        style_applied_params=style_applied_params,
        style_rejections=style_rejections,
        review=review,
        review_skip_reason=review_skip_reason,
        degraded=degraded,
        usage=usage_total,
    )


def _accumulate_usage(total: Dict[str, Any], part: Dict[str, Any]) -> None:
    for key, value in (part or {}).items():
        if isinstance(value, (int, float)):
            total[key] = total.get(key, 0) + value
