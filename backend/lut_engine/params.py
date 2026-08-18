"""LUT 生成参数定义。"""
from dataclasses import dataclass
from typing import Tuple

PHOTO_STYLES = ("STD", "NAT", "VIVD", "VLOG")


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


@dataclass(frozen=True)
class LutParams:
    """调色参数。中性默认值对应恒等变换,构造时 clamp 到合法范围。"""

    base_photo_style: str = "STD"  # STD | NAT | VIVD | VLOG
    temp: float = 0.0              # 色温偏移(Kelvin),正=暖
    tint: float = 0.0              # 色调偏移,正=偏绿
    exposure: float = 0.0          # 曝光(EV)
    contrast: float = 0.0          # 对比度,-1 ~ +1
    saturation: float = 0.0        # 饱和度,-1 ~ +1
    hue: float = 0.0               # 色相旋转(度)
    vibrance: float = 0.0          # 自然饱和度,-1 ~ +1
    tone_map: float = 1.0          # V-Log tone mapping 强度,0~1
    lift: Tuple[float, float, float] = (0.0, 0.0, 0.0)   # 暗部 RGB 偏移
    gamma: Tuple[float, float, float] = (1.0, 1.0, 1.0)  # 中间调 RGB 幂
    gain: Tuple[float, float, float] = (1.0, 1.0, 1.0)   # 亮部 RGB 增益

    def __post_init__(self):
        if self.base_photo_style not in PHOTO_STYLES:
            raise ValueError(
                f"base_photo_style 必须是 {PHOTO_STYLES} 之一,收到 {self.base_photo_style!r}"
            )
        object.__setattr__(self, "temp", _clamp(self.temp, -3000.0, 3000.0))
        object.__setattr__(self, "tint", _clamp(self.tint, -500.0, 500.0))
        object.__setattr__(self, "exposure", _clamp(self.exposure, -3.0, 3.0))
        object.__setattr__(self, "contrast", _clamp(self.contrast, -1.0, 1.0))
        object.__setattr__(self, "saturation", _clamp(self.saturation, -1.0, 1.0))
        object.__setattr__(self, "hue", _clamp(self.hue, -180.0, 180.0))
        object.__setattr__(self, "vibrance", _clamp(self.vibrance, -1.0, 1.0))
        object.__setattr__(self, "tone_map", _clamp(self.tone_map, 0.0, 1.0))
        object.__setattr__(self, "lift", tuple(_clamp(x, -0.1, 0.1) for x in self.lift))
        object.__setattr__(self, "gamma", tuple(_clamp(x, 0.5, 1.5) for x in self.gamma))
        object.__setattr__(self, "gain", tuple(_clamp(x, 0.5, 1.5) for x in self.gain))
