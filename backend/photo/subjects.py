"""将估计的皮肤区域映射为固定像素集合，供调色质量检查使用。"""
from collections.abc import Mapping
import math

import numpy as np

from .stats import downsample, skin_mask_of

REGION_VERSION = "subject-regions-1"
MAX_SUBJECT_REGIONS = 16
MIN_SUBJECT_CONFIDENCE = 0.8
REGION_KINDS = {"face", "hand", "exposed_skin"}


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def valid_region(region):
    """检查显示源图归一化坐标，拒绝越界、退化和非皮肤区域。"""
    if not isinstance(region, Mapping) or region.get("kind") not in REGION_KINDS:
        return False
    bounds = region.get("bounds")
    if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
        return False
    if not all(_finite_number(value) and 0 <= value <= 1 for value in bounds):
        return False
    x0, y0, x1, y1 = bounds
    confidence = region.get("confidence")
    return (x1 > x0 and y1 > y0 and _finite_number(confidence)
            and 0 <= confidence <= 1)


def subject_skin_mask(display_image, analysis=None):
    """返回与 PhotoStats 相同采样尺寸的扁平布尔掩码。

    自动区域只在人物和区域判断均可靠时，与疑似肤色颜色相交。
    人工选择的精确区域可以使用全部像素，覆盖色彩阈值难以命中的皮肤。
    未定位、失败或坐标非法时返回空掩码，不按全图颜色猜测人物。
    调色候选应重复使用此源图掩码，避免颜色变化使保护对象漂移。
    """
    image = np.asarray(display_image)
    if image.ndim != 3 or image.shape[2] < 3:
        raise ValueError("人物区域需要 HxWx3 显示 RGB 图像")
    small = downsample(image[:, :, :3])
    height, width = small.shape[:2]
    empty = np.zeros(height * width, dtype=bool)
    if not isinstance(analysis, Mapping):
        return empty
    if (analysis.get("version") != REGION_VERSION
            or analysis.get("status") != "resolved"
            or analysis.get("subject_mode") != "portrait"
            or analysis.get("source") not in {"auto", "manual"}):
        return empty
    confidence = analysis.get("confidence")
    if not _finite_number(confidence) or not MIN_SUBJECT_CONFIDENCE <= confidence <= 1:
        return empty
    regions = analysis.get("regions")
    if (not isinstance(regions, list) or not 0 < len(regions) <= MAX_SUBJECT_REGIONS
            or not all(valid_region(region) for region in regions)):
        return empty
    mode = analysis.get("mask_mode", "skin_candidates")
    if mode not in {"skin_candidates", "all_pixels"}:
        return empty
    if mode == "all_pixels" and analysis.get("source") != "manual":
        return empty

    x = (np.arange(width) + 0.5) / width
    y = (np.arange(height) + 0.5) / height
    selected = np.zeros((height, width), dtype=bool)
    for region in regions:
        if region["confidence"] < MIN_SUBJECT_CONFIDENCE:
            continue
        x0, y0, x1, y1 = region["bounds"]
        selected |= ((y[:, None] >= y0) & (y[:, None] < y1)
                     & (x[None, :] >= x0) & (x[None, :] < x1))
    if mode == "skin_candidates":
        selected &= skin_mask_of(image).reshape(height, width)
    return selected.ravel()
