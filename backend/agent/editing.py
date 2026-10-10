"""调色任务的创作目标与参数保护,不扩展 LUT 参数集合。"""
import json
from dataclasses import asdict
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from lut_engine import LutParams

PARAM_FIELDS = tuple(LutParams.__dataclass_fields__)
AUTO_READONLY_FIELDS = ("base_photo_style", "tone_map")
ATMOSPHERE_FIELDS = ("exposure", "temp", "tint")


class EditingContext(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    goal_mode: Literal["natural", "preserve", "style_only"] = "natural"
    locked_fields: list[str] = Field(default_factory=list)

    @field_validator("locked_fields")
    @classmethod
    def known_parameters(cls, values: list[str]) -> list[str]:
        unknown = set(values) - set(PARAM_FIELDS)
        if unknown:
            raise ValueError(f"未知的保护参数: {', '.join(sorted(unknown))}")
        return list(dict.fromkeys(values))


def normalize_context(context: EditingContext | dict | None = None) -> EditingContext:
    if isinstance(context, EditingContext):
        return context.model_copy(deep=True)
    return EditingContext.model_validate({} if context is None else context)


def parameter_snapshot(params: dict[str, Any]) -> dict[str, Any]:
    """复制包含 RGB 数组的参数,使阶段来源不随后续编辑改变。"""
    return {key: list(value) if isinstance(value, (list, tuple)) else value
            for key, value in params.items()}


def complete_params(params: dict[str, Any]) -> dict[str, Any]:
    return {**parameter_snapshot(asdict(LutParams())), **parameter_snapshot(params)}


def writable_fields(context: EditingContext | dict | None, stage: str) -> set[str]:
    ctx = normalize_context(context)
    if stage == "correction":
        from .schemas import CorrectionProposal

        fields = set(CorrectionProposal.model_fields) - {"diagnosis"}
        if ctx.goal_mode == "style_only":
            return set()
        if ctx.goal_mode == "preserve":
            fields -= set(ATMOSPHERE_FIELDS)
    elif stage == "rules":
        fields = {"exposure", "temp"} if ctx.goal_mode == "natural" else set()
    else:
        fields = set(PARAM_FIELDS)
    if stage != "chat":
        fields -= set(AUTO_READONLY_FIELDS)
    return fields - set(ctx.locked_fields)


def application_reasons(before: dict, candidate: dict,
                        context: EditingContext | dict | None, stage: str) -> list[str]:
    """对最终候选验证保护与阶段权限;任一冲突拒绝整个提议。"""
    ctx = normalize_context(context)
    old, new = complete_params(before), complete_params(candidate)
    reasons = [f"参数 {key} 已锁定,本次提议未应用"
               for key in ctx.locked_fields if old[key] != new[key]]
    if stage != "chat":
        reasons.extend(f"输入参数 {key} 在自动修图中只读"
                       for key in AUTO_READONLY_FIELDS if old[key] != new[key])
    if stage in {"correction", "rules"}:
        if ctx.goal_mode == "preserve":
            reasons.extend(f"保留氛围禁止基础校正修改 {key}"
                           for key in ATMOSPHERE_FIELDS if old[key] != new[key])
        elif ctx.goal_mode == "style_only" and old != new:
            reasons.append("只调整风格模式不允许基础校正或规则兜底")
    return reasons


def context_prompt(context: EditingContext | dict | None, stage: str) -> str:
    ctx = normalize_context(context)
    text = "编辑上下文:" + json.dumps(ctx.model_dump(), ensure_ascii=False)
    if ctx.goal_mode == "preserve":
        text += "\n保留氛围:暗调和暖冷倾向属于观察,不要默认视为错误或要求归一化。"
        if stage == "correction":
            text += "基础校正不得修改 exposure、temp、tint。"
        else:
            text += "只落实用户明确要求的风格改变,保留其余氛围。"
    elif ctx.goal_mode == "style_only":
        text += "\n只落实用户明确要求的风格,不执行基础曝光或白平衡校正。"
    text += "\n锁定字段不得改变;相同目标值或零增量可以保持原值。"
    if ctx.locked_fields:
        text += "锁定项:" + ", ".join(ctx.locked_fields)
    return text
