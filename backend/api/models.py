"""HTTP 参数与轻量元数据校验。"""
import json
from typing import List, Literal
from pydantic import BaseModel, ConfigDict, Field
from agent.schemas import RGBOffsetValue, RGBScaleValue

class LutParamsModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    base_photo_style: Literal["STD", "NAT", "VIVD", "VLOG"] = "STD"
    temp: float = Field(0.0, ge=-3000, le=3000)
    tint: float = Field(0.0, ge=-500, le=500)
    exposure: float = Field(0.0, ge=-3, le=3)
    contrast: float = Field(0.0, ge=-1, le=1)
    contrast_pivot: float = Field(0.462, ge=0.1, le=0.9)
    saturation: float = Field(0.0, ge=-1, le=1)
    hue: float = Field(0.0, ge=-180, le=180)
    vibrance: float = Field(0.0, ge=-1, le=1)
    tone_map: float = Field(1.0, ge=0, le=1)
    look_strength: float = Field(1.0, ge=0, le=1)
    # 影调分区(逐点,可烘进 33³ LUT)
    highlights: float = Field(0.0, ge=-1, le=1)
    shadows: float = Field(0.0, ge=-1, le=1)
    whites: float = Field(0.0, ge=-1, le=1)
    blacks: float = Field(0.0, ge=-1, le=1)
    curve: float = Field(0.0, ge=-1, le=1)
    # 分离色调
    split_shadow_hue: float = Field(0.0, ge=0, le=360)
    split_shadow_sat: float = Field(0.0, ge=0, le=1)
    split_highlight_hue: float = Field(0.0, ge=0, le=360)
    split_highlight_sat: float = Field(0.0, ge=0, le=1)
    split_balance: float = Field(0.5, ge=0, le=1)
    split_mid_hue: float = Field(0.0, ge=0, le=360)
    split_mid_sat: float = Field(0.0, ge=0, le=1)
    selective_hue_center: float = Field(30.0, ge=0, le=360)
    selective_hue_width: float = Field(45.0, ge=1, le=180)
    selective_hue_shift: float = Field(0.0, ge=-180, le=180)
    selective_saturation: float = Field(0.0, ge=-1, le=1)
    lift: List[RGBOffsetValue] = Field([0.0, 0.0, 0.0], min_length=3, max_length=3)
    gamma: List[RGBScaleValue] = Field([1.0, 1.0, 1.0], min_length=3, max_length=3)
    gain: List[RGBScaleValue] = Field([1.0, 1.0, 1.0], min_length=3, max_length=3)


def checked_metadata(value):
    if value is None:
        return None
    if not isinstance(value, (dict, list)):
        raise ValueError("元数据必须是对象或数组")
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > 128 * 1024:
        raise ValueError("元数据超过 128KB")
    def check(item):
        if isinstance(item,str) and ("data:image/" in item.lower() or item.lower().startswith("data:")
                or item.startswith(("/9j/","iVBORw0KGgo","R0lGOD","UklGR")) or len(item) > 8192):
            raise ValueError("元数据不能包含图片或大段二进制内容")
        if isinstance(item, dict):
            for child in item.values():
                check(child)
        elif isinstance(item, list):
            for child in item:
                check(child)
    check(value)
    return value
