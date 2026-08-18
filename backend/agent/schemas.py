"""LLM 输出的结构化结果。intent 区分「确认生成」与「描述/调整风格」。"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

# 风格参数字段,任一非空即认为用户表达了风格诉求
STYLE_FIELDS = (
    "base_photo_style", "tone_map",
    "temp", "tint", "exposure", "contrast", "saturation",
    "hue", "vibrance", "lift", "gamma", "gain",
)


class ExtractResult(BaseModel):
    intent: Literal["confirm", "describe"] = Field(
        ..., description="用户意图:confirm=确认生成或同意;describe=描述或调整风格"
    )
    base_photo_style: Optional[Literal["STD", "NAT", "VIVD", "VLOG"]] = Field(
        None, description="基准照片风格,只能是 STD、NAT、VIVD、VLOG 之一,未提及则留空"
    )
    temp: Optional[float] = Field(
        None, description="色温偏移,单位 Kelvin,范围约 -3000 到 3000,正数偏暖。如 +400 表示暖调, -300 表示冷调"
    )
    tint: Optional[float] = Field(
        None, description="色调偏移,范围约 -500 到 500,正数偏绿、负数偏洋红"
    )
    exposure: Optional[float] = Field(
        None, description="曝光,单位 EV,范围约 -3 到 3,正数提亮"
    )
    contrast: Optional[float] = Field(
        None, description="对比度,范围 -1 到 1,如 -0.15 表示轻微降低对比"
    )
    saturation: Optional[float] = Field(
        None, description="饱和度,范围 -1 到 1,如 -0.1 表示轻微降低饱和"
    )
    hue: Optional[float] = Field(
        None, description="色相旋转,单位度,范围 -180 到 180"
    )
    vibrance: Optional[float] = Field(
        None, description="自然饱和度,范围 -1 到 1"
    )
    tone_map: Optional[float] = Field(
        None, description="V-Log 基准的 tone mapping 强度,0 到 1,默认 1,仅 V-Log 基准生效"
    )
    lift: Optional[List[float]] = Field(
        None, description="暗部 RGB 偏移,三个 -0.1 到 0.1 之间的小数,如 [0.03, 0.0, -0.02]"
    )
    gamma: Optional[List[float]] = Field(
        None, description="中间调 RGB 幂,三个 0.5 到 1.5 之间的小数,如 [0.9, 1.0, 1.0]"
    )
    gain: Optional[List[float]] = Field(
        None, description="亮部 RGB 增益,三个 0.5 到 1.5 之间的小数,如 [1.05, 1.0, 1.0]"
    )
