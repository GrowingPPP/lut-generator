"""合成测试图生成器。

真实照片不适合做断言:数值不稳定、体积大、有版权问题。这里用程序生成**带已知缺陷**
的图,让每个 Issue 都有可控的输入 —— 只有输入可控,才敢断言「欠曝图必然产出
under_exposed」而不会因为换一张照片就测试变红。

所有生成器都是确定性的(固定随机种子),同一 kind 必然产出同一张图。
"""
from typing import Tuple

import numpy as np

DEFAULT_SIZE = (360, 480)   # (height, width)


def _grid(h: int, w: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:h, 0:w]
    return yy.astype(np.float32) / max(h - 1, 1), xx.astype(np.float32) / max(w - 1, 1), np.zeros((h, w), np.float32)


def _base_scene(h: int, w: int) -> np.ndarray:
    """一张结构固定的「风景 + 人像」底图,便于叠加各类缺陷。

    含天空渐变、地面、深色衣物、暖色人脸 —— 覆盖亮部/暗部/肤色三类区域。
    """
    ty, tx, _ = _grid(h, w)
    img = np.zeros((h, w, 3), np.float32)

    # 天空:整体偏冷(B 最高),且**保持米色/暖色远离肤色特征** ——
    # 否则单像素肤色检测会把大片天空误判成皮肤(实测过:暖色地平线会让 skin_ratio 冲到 51%,
    # 而真实照片里天空与肤色是可分的:「暖米色渐变」与「皮肤」在颜色空间本就接近)。
    # 光比要够大:真实照片动态范围(p95−p5)通常在 0.5~0.75。
    # 早期版本只有 0.38,几乎贴着 flat_haze 阈值 —— 基准图自己就被判成「发灰」。
    sky = ty < 0.60
    u = np.where(sky, ty / 0.60, 0.0)
    img[..., 0] = np.where(sky, 0.30 + 0.42 * u, 0.24)
    img[..., 1] = np.where(sky, 0.37 + 0.36 * u, 0.25)
    img[..., 2] = np.where(sky, 0.52 + 0.14 * u, 0.31)

    # 深色衣物(近中性偏蓝,不落入肤色)
    cloth = (ty > 0.66) & (tx > 0.30) & (tx < 0.74)
    img[cloth] = [0.08, 0.09, 0.12]

    # 人脸:明确的暖色,R 主导且 R−B 足够大 —— 典型肤色
    fx, fy = (tx - 0.60) / 0.10, (ty - 0.50) / 0.13
    face = fx * fx + fy * fy < 1.0
    img[face] = [0.72, 0.60, 0.53]

    # 高光点:略暖但不进入肤色区间(R−B 明显大于肤色下限)
    sx, sy = (tx - 0.20) / 0.05, (ty - 0.30) / 0.05
    img[sx * sx + sy * sy < 1.0] = [0.96, 0.94, 0.88]

    return np.clip(img, 0.0, 1.0)


def _flat_backdrop(h: int, w: int) -> np.ndarray:
    """肤色 fixture 的中性背景:带足够反差,避免整张图被判成「发灰」。"""
    ty, tx, _ = _grid(h, w)
    v = 0.14 + 0.62 * (0.5 * ty + 0.5 * (1.0 - tx))
    return np.stack([v, v * 1.02, v * 1.08], axis=-1).astype(np.float32)


def _noise(h: int, w: int, sigma: float, seed: int) -> np.ndarray:
    return np.random.RandomState(seed).normal(0.0, sigma, (h, w, 3)).astype(np.float32)


def make_fixture(kind: str, size: Tuple[int, int] = DEFAULT_SIZE) -> np.ndarray:
    """按 kind 生成一张带已知缺陷的图。

    kind:
      neutral          基准场景(无明显缺陷,用于反向断言)
      under_exposed    整体偏暗
      over_exposed     整体偏亮
      low_contrast     动态范围窄
      flat_haze        区间窄且中调偏灰(灰雾)
      warm_cast        三通道整体偏暖(R > B)
      cool_cast        偏冷(B > R)
      shadow_blue      仅暗部偏蓝(全局可能中性 —— 测分段测量)
      over_saturated   高饱和
      highlight_clip   大面积高光溢出
      skin_tone        含标准肤色块
      skin_dark        深肤色(防止肤色检测只对浅肤色有效)
      noisy            叠加已知 sigma 的高斯噪点
    """
    h, w = size
    if kind == "neutral":
        return _base_scene(h, w)

    if kind == "under_exposed":
        return np.clip(_base_scene(h, w) * 0.45, 0.0, 1.0)

    if kind == "over_exposed":
        return np.clip(_base_scene(h, w) * 1.55 + 0.12, 0.0, 1.0)

    if kind == "low_contrast":
        # 压缩系数要落在 FLAT_HAZE_RANGE(0.28) 与 LOW_CONTRAST_RANGE(0.30) **之间**,
        # 否则这张图会掉进更严的灰雾判定,证明不了「低对比」这条规则。
        return np.clip(0.45 + (_base_scene(h, w) - 0.5) * 0.48, 0.0, 1.0)

    if kind == "flat_haze":
        return np.clip(0.42 + (_base_scene(h, w) - 0.5) * 0.30, 0.0, 1.0)

    if kind == "warm_cast":
        # R 抬、B 与 G 都压 —— 只压 B 会把三通道推向均衡,
        # 反而让 gray_world_dev(相对均值的 RMS 偏差)变小,判定层就抓不到了。
        base = _base_scene(h, w)
        return np.clip(base * np.array([1.35, 0.92, 0.66], np.float32), 0.0, 1.0)

    if kind == "cool_cast":
        base = _base_scene(h, w)
        return np.clip(base * np.array([0.82, 0.98, 1.14], np.float32), 0.0, 1.0)

    if kind == "shadow_blue":
        # 目标:全局接近中性,但暗部明显偏蓝 —— 这才是「白平衡问题」而非「光线氛围」。
        # 基准场景本身偏冷(天空是蓝的),所以先做一次全局暖化把均值拉回中性,
        # 再只给暗部加蓝。否则全局 B−R 已经很大,分段测量体现不出「只在暗部」。
        base = _base_scene(h, w)
        neutralized = base * np.array([1.30, 1.02, 0.80], np.float32)
        lum = base @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        w_dark = np.clip((0.45 - lum) / 0.45, 0.0, 1.0)[..., None]
        return np.clip(neutralized + w_dark * np.array([-0.06, -0.02, 0.14], np.float32), 0.0, 1.0)

    if kind == "over_saturated":
        base = _base_scene(h, w)
        lum = (base @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
        return np.clip(lum + (base - lum) * 2.6, 0.0, 1.0)

    if kind == "highlight_clip":
        base = _base_scene(h, w)
        out = np.clip(base * 1.9 + 0.25, 0.0, 1.0)
        out[0: int(h * 0.3), :] = 1.0        # 顶部三分之一全白 → 明确溢出
        return out

    if kind == "skin_tone":
        img = _flat_backdrop(h, w)
        img[int(h * 0.25): int(h * 0.75), int(w * 0.25): int(w * 0.75)] = [0.84, 0.66, 0.56]
        return img

    if kind == "skin_dark":
        img = _flat_backdrop(h, w)
        img[int(h * 0.25): int(h * 0.75), int(w * 0.25): int(w * 0.75)] = [0.42, 0.30, 0.24]
        return img

    if kind == "noisy":
        # 降饱和后再加噪:噪声是逐通道独立叠加的,本身就会抬高饱和度指标,
        # 否则这张图会顺带被判「过饱和」,掩盖它真正要测的噪声估计。
        base = _base_scene(h, w)
        lum = (base @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
        desat = lum + (base - lum) * 0.55
        return np.clip(desat + _noise(h, w, 0.06, seed=1234), 0.0, 1.0)

    raise ValueError(f"未知的 fixture kind: {kind!r}")


ALL_KINDS = (
    "neutral", "under_exposed", "over_exposed", "low_contrast", "flat_haze",
    "warm_cast", "cool_cast", "shadow_blue", "over_saturated", "highlight_clip",
    "skin_tone", "skin_dark", "noisy",
)


def make_jpeg_bytes(kind: str = "neutral", size: Tuple[int, int] = DEFAULT_SIZE,
                    quality: int = 88) -> bytes:
    """生成 JPEG 字节流,供 API 与浏览器测试当上传样本。"""
    import io

    from PIL import Image

    arr = (np.clip(make_fixture(kind, size), 0.0, 1.0) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr, "RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()
