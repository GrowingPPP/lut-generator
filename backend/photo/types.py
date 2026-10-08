"""自动修图的数据结构。

这一层是纯数据,不含任何计算逻辑 —— 计算在 stats.py / quality.py / render.py。
`photo/*` 整体不依赖 FastAPI / LLM / 数据库,可以脱离一切框架单测。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Tuple

# 图像读入后的统一形态:float32 HxWx3,值域 0..1
RGB = Tuple[float, float, float]

Stage = Literal["optimize", "style"]


class PhotoError(Exception):
    """图片相关的可预期错误(格式不支持、损坏、过大)。API 层翻译成 4xx。"""


class UnsupportedImageError(PhotoError):
    """不是受支持的图片格式。"""


class CorruptImageError(PhotoError):
    """格式对但内容损坏,解不开。"""


class ImageTooLargeError(PhotoError):
    """像素数或字节数超出限制。"""


@dataclass(frozen=True, slots=True)
class PhotoStats:
    """一张照片的客观测量结果。

    全部为确定性数值:同一输入必然得到同一输出(有测试锁住这一点)。
    所有分位数与均值都在**编码值域**(0..1)上计算,不做线性化 ——
    判据阈值是按编码值标定的,线性化后阈值全部失效。
    """

    width: int
    height: int
    sampled_px: int

    # 亮度(Rec.709 加权)
    lum_p1: float
    lum_p5: float
    lum_p50: float
    lum_p95: float
    lum_p99: float

    # 裁剪
    highlight_clip_pct: float   # any(channel) > 0.98 的像素占比 ×100
    shadow_clip_pct: float      # max(channel) < 0.02 的像素占比 ×100

    # 通道与色偏
    rgb_mean: RGB
    rgb_median: RGB
    shadow_cast: RGB            # 最暗 20% 像素的通道均值
    highlight_cast: RGB         # 最亮 20% 像素的通道均值
    gray_world_dev: float       # 灰世界偏差,0 = 三通道均值相等

    # 饱和度
    saturation_mean: float
    saturation_p95: float

    # 主体保护
    skin_ratio: float
    skin_mean_rgb: Optional[RGB]
    skin_lum_p50: Optional[float]

    # 画质
    noise_sigma: float


@dataclass(frozen=True, slots=True)
class Issue:
    """一个可诊断的问题。

    evidence 会**原样出现在 UI 的「修改说明」里**,所以必须是给人看的证据句,
    不能写成 "p50 too low" 这种代码腔 —— 这份文案同时服务「喂 LLM」和「给人看」。
    """

    code: str
    severity: float             # 0..1
    evidence: str
    suggested: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class StepReport:
    """编排过程中一步的记录,用于 UI 展示与问题排查。"""

    stage: Stage
    round: int
    diagnosis: str = ""
    proposed: Dict[str, Any] = field(default_factory=dict)
    applied: bool = False
    stats_after: Optional[PhotoStats] = None
    rejections: List[str] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class AutoGradeResult:
    """一次自动修图的产出。"""

    params: Dict[str, Any]              # 最终参数,可直接喂 LutParamsModel
    steps: List[StepReport] = field(default_factory=list)
    issues: List[Issue] = field(default_factory=list)
    style_params: Optional[Dict[str, Any]] = None   # 风格阶段抽到的增量,供用户核对
    review: Optional[str] = None                     # 视觉复检意见
    degraded: bool = False                           # 未达标,已采用保守解
    usage: Dict[str, Any] = field(default_factory=dict)
