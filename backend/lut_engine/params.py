"""LUT 生成参数定义。"""
from dataclasses import dataclass, field
from typing import Tuple
from .curves import identity_curves, validate_curve_points
from .imported import validate_external_options

PHOTO_STYLES = ("STD", "NAT", "VIVD", "VLOG")


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


@dataclass(frozen=True)
class LutParams:
    """调色参数。照片基准的中性默认值对应恒等变换；V-Log 默认包含显示转换。"""

    base_photo_style: str = "STD"  # STD | NAT | VIVD | VLOG
    temp: float = 0.0              # 色温偏移(Kelvin),正=暖
    tint: float = 0.0              # 色调偏移,正=偏绿
    exposure: float = 0.0          # 曝光(EV)
    contrast: float = 0.0          # 对比度,-1 ~ +1
    contrast_pivot: float = 0.462   # 对比中心,编码域灰阶
    saturation: float = 0.0        # 饱和度,-1 ~ +1
    hue: float = 0.0               # 色相旋转(度)
    vibrance: float = 0.0          # 自然饱和度,-1 ~ +1
    tone_map: float = 1.0          # V-Log tone mapping 强度,0~1
    look_strength: float = 1.0     # 创意风格强度,不衰减输入转换和单张校正

    # ---- 影调分区(逐点运算,均可烘进 33³ LUT)----
    highlights: float = 0.0        # 高光,负=压高光 / 正=提亮部
    shadows: float = 0.0           # 阴影,正=提阴影 / 负=压暗部
    whites: float = 0.0            # 白部层次,正=增强 / 负=降低白点
    blacks: float = 0.0            # 黑部层次,正=抬黑位 / 负=压暗部
    curve: float = 0.0             # S 曲线强度,-1 ~ +1(平滑对比)
    curve_points: dict = field(default_factory=identity_curves)
    external_lut_id: str | None = None
    external_lut_strength: float = 0.0
    external_lut_mode: str = "display"

    # ---- 分离色调(逐点)----
    split_shadow_hue: float = 0.0      # 阴影染色色相(度),0=红,120=绿,240=蓝
    split_shadow_sat: float = 0.0      # 阴影染色强度,0~1
    split_highlight_hue: float = 0.0   # 高光染色色相(度)
    split_highlight_sat: float = 0.0   # 高光染色强度,0~1
    split_balance: float = 0.5         # 阴影/高光分界,0~1,越大高光染色范围越广
    split_mid_hue: float = 0.0         # 中间调染色色相
    split_mid_sat: float = 0.0         # 中间调染色强度

    selective_hue_center: float = 30.0  # 局部色相的目标中心
    selective_hue_width: float = 45.0   # 色相作用半径
    selective_hue_shift: float = 0.0    # 目标色相偏移
    selective_saturation: float = 0.0   # 目标色饱和度偏移

    lift: Tuple[float, float, float] = (0.0, 0.0, 0.0)   # 线性域 RGB 偏移
    gamma: Tuple[float, float, float] = (1.0, 1.0, 1.0)  # 中间调 RGB 幂
    gain: Tuple[float, float, float] = (1.0, 1.0, 1.0)   # 线性域 RGB 增益

    def __post_init__(self):
        object.__setattr__(self, "curve_points", validate_curve_points(self.curve_points))
        external_id, strength, mode = validate_external_options(
            self.external_lut_id, self.external_lut_strength, self.external_lut_mode)
        if mode == "input" and self.base_photo_style != "VLOG":
            raise ValueError("外部输入转换仅支持 VLOG 工作区")
        object.__setattr__(self, "external_lut_id", external_id)
        object.__setattr__(self, "external_lut_strength", strength)
        if self.base_photo_style not in PHOTO_STYLES:
            raise ValueError(
                f"base_photo_style 必须是 {PHOTO_STYLES} 之一,收到 {self.base_photo_style!r}"
            )
        object.__setattr__(self, "temp", _clamp(self.temp, -3000.0, 3000.0))
        object.__setattr__(self, "tint", _clamp(self.tint, -500.0, 500.0))
        object.__setattr__(self, "exposure", _clamp(self.exposure, -3.0, 3.0))
        object.__setattr__(self, "contrast", _clamp(self.contrast, -1.0, 1.0))
        object.__setattr__(self, "contrast_pivot", _clamp(self.contrast_pivot, 0.1, 0.9))
        object.__setattr__(self, "saturation", _clamp(self.saturation, -1.0, 1.0))
        object.__setattr__(self, "hue", _clamp(self.hue, -180.0, 180.0))
        object.__setattr__(self, "vibrance", _clamp(self.vibrance, -1.0, 1.0))
        object.__setattr__(self, "tone_map", _clamp(self.tone_map, 0.0, 1.0))
        object.__setattr__(self, "look_strength", _clamp(self.look_strength, 0.0, 1.0))
        object.__setattr__(self, "highlights", _clamp(self.highlights, -1.0, 1.0))
        object.__setattr__(self, "shadows", _clamp(self.shadows, -1.0, 1.0))
        object.__setattr__(self, "whites", _clamp(self.whites, -1.0, 1.0))
        object.__setattr__(self, "blacks", _clamp(self.blacks, -1.0, 1.0))
        object.__setattr__(self, "curve", _clamp(self.curve, -1.0, 1.0))
        object.__setattr__(self, "split_shadow_hue", _clamp(self.split_shadow_hue, 0.0, 360.0))
        object.__setattr__(self, "split_shadow_sat", _clamp(self.split_shadow_sat, 0.0, 1.0))
        object.__setattr__(self, "split_highlight_hue", _clamp(self.split_highlight_hue, 0.0, 360.0))
        object.__setattr__(self, "split_highlight_sat", _clamp(self.split_highlight_sat, 0.0, 1.0))
        object.__setattr__(self, "split_balance", _clamp(self.split_balance, 0.0, 1.0))
        object.__setattr__(self, "split_mid_hue", _clamp(self.split_mid_hue, 0.0, 360.0))
        object.__setattr__(self, "split_mid_sat", _clamp(self.split_mid_sat, 0.0, 1.0))
        object.__setattr__(self, "selective_hue_center", _clamp(self.selective_hue_center, 0.0, 360.0))
        object.__setattr__(self, "selective_hue_width", _clamp(self.selective_hue_width, 1.0, 180.0))
        object.__setattr__(self, "selective_hue_shift", _clamp(self.selective_hue_shift, -180.0, 180.0))
        object.__setattr__(self, "selective_saturation", _clamp(self.selective_saturation, -1.0, 1.0))
        object.__setattr__(self, "lift", tuple(_clamp(x, -0.1, 0.1) for x in self.lift))
        object.__setattr__(self, "gamma", tuple(_clamp(x, 0.5, 1.5) for x in self.gamma))
        object.__setattr__(self, "gain", tuple(_clamp(x, 0.5, 1.5) for x in self.gain))
