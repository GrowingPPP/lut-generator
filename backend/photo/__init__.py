"""自动修图的纯计算层。

**不得** import fastapi / openai / storage —— 这一层要能脱离一切框架单测,
即不需要 API key、不需要数据库、不需要网络。
"""
from .types import (
    AutoGradeResult,
    CorruptImageError,
    ImageTooLargeError,
    Issue,
    PhotoError,
    PhotoStats,
    StepReport,
    UnsupportedImageError,
)

__all__ = [
    "AutoGradeResult",
    "CorruptImageError",
    "ImageTooLargeError",
    "Issue",
    "PhotoError",
    "PhotoStats",
    "StepReport",
    "UnsupportedImageError",
    "analyze",
    "diagnose",
    "load_image",
    "render_lut",
]


def __getattr__(name):
    # 延迟导入:避免 photo/__init__ 一被引用就把 numpy/PIL 全拉起来
    if name in ("analyze", "load_image", "downsample", "to_prompt_dict"):
        from . import stats
        return getattr(stats, name)
    if name == "diagnose":
        from . import quality
        return quality.diagnose
    if name in ("render_lut", "to_data_url", "lut_from_params"):
        from . import render
        return getattr(render, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
