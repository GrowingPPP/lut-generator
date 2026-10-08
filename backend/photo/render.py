"""LUT 渲染:把 (N,N,N,3) 的 LUT 应用到 HxWx3 图像。

**采样语义必须与前端 shader 完全一致**(`frontend/src/lib/lutPreview.js`):

    float s = (lutSize - 1.0) / lutSize;
    vec3 coord = c * s + 0.5 / lutSize;
    vec3 graded = texture(u_lut, coord).rgb;   // 三线性 + CLAMP_TO_EDGE

否则「模型看到的渲染图」与「用户预览图」会有系统性偏差 —— 视觉复检就失去意义了。
这里用 numpy 手写向量化三线性(实测 240×320 约 18 ms),不引入 scipy。
"""
import base64
import io
from typing import Any, Dict, Optional

import numpy as np
from PIL import Image

from lut_engine import generate_lut, lut_params_from_dict

DEFAULT_LUT_SIZE = 33
PREVIEW_MAX_SIDE = 768      # 发给模型的图:体积与细节的折中(实测 768px q80 ≈ 246 KB)
PREVIEW_QUALITY = 80


def lut_from_params(params: Dict[str, Any], size: int = DEFAULT_LUT_SIZE) -> np.ndarray:
    """参数 → LUT。薄封装,便于测试与替换。"""
    return generate_lut(lut_params_from_dict(params), size=size)


def render_lut(lut: np.ndarray, img: np.ndarray) -> np.ndarray:
    """三线性采样。img 为 float32 HxWx3,值域 0..1;返回同形状。

    与 shader 一致的三个要点:
      1. 归一化坐标带半像素偏移(居中采样)
      2. 三线性插值
      3. CLAMP_TO_EDGE(超出 [0,1] 的输入被夹到边界,而不是回绕或外推)
    """
    if img.ndim != 3 or img.shape[2] < 3:
        raise ValueError(f"期望 HxWx3 的 RGB 图,收到 shape={img.shape}")
    n = lut.shape[0]
    if lut.shape != (n, n, n, 3):
        raise ValueError(f"期望 (N,N,N,3) 的 LUT,收到 shape={lut.shape}")

    rgb = np.clip(img[:, :, :3], 0.0, 1.0).astype(np.float32)

    # shader: coord = c*(n-1)/n + 0.5/n;再换算回网格索引 pos = coord*n - 0.5
    s = (n - 1.0) / n
    coord = rgb * s + 0.5 / n
    pos = coord * n - 0.5

    i0 = np.floor(pos).astype(np.int32)
    frac = (pos - i0).astype(np.float32)
    i0c = np.clip(i0, 0, n - 1)
    i1c = np.clip(i0 + 1, 0, n - 1)

    out = np.zeros_like(rgb)
    for dz in (0, 1):
        wz = frac[:, :, 2] if dz else 1.0 - frac[:, :, 2]
        zi = i1c[:, :, 2] if dz else i0c[:, :, 2]
        for dy in (0, 1):
            wy = frac[:, :, 1] if dy else 1.0 - frac[:, :, 1]
            yi = i1c[:, :, 1] if dy else i0c[:, :, 1]
            for dx in (0, 1):
                wx = frac[:, :, 0] if dx else 1.0 - frac[:, :, 0]
                xi = i1c[:, :, 0] if dx else i0c[:, :, 0]
                w = (wx * wy * wz).astype(np.float32)
                out += lut[xi, yi, zi] * w[:, :, None]

    return np.clip(out, 0.0, 1.0).astype(np.float32)


def to_data_url(img: np.ndarray, max_side: int = PREVIEW_MAX_SIDE,
                quality: int = PREVIEW_QUALITY) -> str:
    """float RGB(0..1)→ JPEG base64 data URL,供视觉复检发给模型。

    长边压到 max_side:模型侧 token 有上限(每张约 1024),压缩只影响传输体积。
    """
    arr = (np.clip(img[:, :, :3], 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    pil = Image.fromarray(arr, "RGB")
    h, w = arr.shape[:2]
    if max(h, w) > max_side:
        scale = max_side / max(h, w)
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    pil.save(buf, "JPEG", quality=quality, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def side_by_side(before: np.ndarray, after: np.ndarray,
                 gap: int = 12) -> np.ndarray:
    """把原图与渲染图左右拼接成一张,供视觉复检一次发送。

    拼成一张比发两张更省:模型能直接比较同一构图,也少一次图片 token 开销。
    """
    if before.shape != after.shape:
        raise ValueError(f"两张图尺寸必须一致:{before.shape} vs {after.shape}")
    h, w = before.shape[:2]
    canvas = np.zeros((h, w * 2 + gap, 3), np.float32)
    canvas[:, :w] = np.clip(before[:, :, :3], 0, 1)
    canvas[:, w + gap:] = np.clip(after[:, :, :3], 0, 1)
    canvas[:, w:w + gap] = 0.08      # 中缝:暗灰,便于模型区分两侧
    return canvas


def downsample_for_analysis(img: np.ndarray, max_side: int) -> np.ndarray:
    """分析前降采样(与 photo.stats.downsample 同语义,这里避免循环依赖)。"""
    from .stats import downsample
    return downsample(img, max_side)


def is_identity_error(lut: np.ndarray, img: Optional[np.ndarray] = None) -> float:
    """诊断辅助:恒等 LUT 渲染后与原图的最大偏差。用于测试与自检。"""
    from lut_engine import build_grid
    if img is None:
        img = build_grid(lut.shape[0]).reshape(-1, 3).reshape(
            lut.shape[0], lut.shape[1] * lut.shape[2], 3)[:, :, :]
    return float(np.abs(render_lut(lut, img) - np.clip(img, 0, 1)).max())
