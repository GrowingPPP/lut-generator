"""四通道单调 PCHIP 曲线,控制点仅定义编码 RGB 的逐点变换。"""
from math import isfinite
import numpy as np

CURVE_CHANNELS = ("master", "r", "g", "b")
MAX_CURVE_POINTS = 16
MIN_POINT_DISTANCE = 0.0001


def identity_curves():
    return {channel: [[0.0, 0.0], [1.0, 1.0]] for channel in CURVE_CHANNELS}


def validate_curve_points(value):
    if not isinstance(value, dict) or set(value) != set(CURVE_CHANNELS):
        raise ValueError("曲线必须包含 master、r、g、b 四个通道")
    result = {}
    for channel in CURVE_CHANNELS:
        points = value[channel]
        if not isinstance(points, (list, tuple)) or not 2 <= len(points) <= MAX_CURVE_POINTS:
            raise ValueError("每条曲线需要 2–16 个控制点")
        normalized = []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError("控制点必须是 [输入,输出]")
            if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not isfinite(n) or not 0 <= n <= 1 for n in point):
                raise ValueError("曲线控制点必须是 0–1 的有限数字")
            normalized.append([float(point[0]), float(point[1])])
        if normalized[0][0] != 0 or normalized[-1][0] != 1:
            raise ValueError("曲线输入端点必须为 0 和 1")
        for before, after in zip(normalized, normalized[1:]):
            if after[0] - before[0] < MIN_POINT_DISTANCE or after[1] < before[1]:
                raise ValueError("曲线输入需严格递增且至少间隔 0.0001,输出不能下降")
        result[channel] = normalized
    return result


def pchip_slopes(points):
    xy = np.asarray(points, dtype=np.float64)
    h = np.diff(xy[:, 0])
    delta = np.diff(xy[:, 1]) / h
    slopes = np.zeros(len(points), dtype=np.float64)
    if len(points) == 2:
        slopes[:] = delta[0]
        return slopes
    for i in range(1, len(points) - 1):
        if delta[i - 1] > 0 and delta[i] > 0:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            slopes[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i])
    slopes[0] = np.clip(((2*h[0]+h[1])*delta[0]-h[0]*delta[1])/(h[0]+h[1]), 0, 3*delta[0])
    slopes[-1] = np.clip(((2*h[-1]+h[-2])*delta[-1]-h[-1]*delta[-2])/(h[-1]+h[-2]), 0, 3*delta[-1])
    return slopes


def evaluate_curve(values, points):
    if points == [[0.0, 0.0], [1.0, 1.0]]:
        return np.clip(np.asarray(values, dtype=np.float64), 0.0, 1.0)
    xy = np.asarray(points, dtype=np.float64)
    slopes = pchip_slopes(points)
    values = np.clip(np.asarray(values, dtype=np.float64), 0.0, 1.0)
    index = np.clip(np.searchsorted(xy[:, 0], values, side="right") - 1, 0, len(points)-2)
    h = xy[index+1, 0] - xy[index, 0]
    t = (values - xy[index, 0]) / h
    t2, t3 = t*t, t*t*t
    return np.clip((2*t3-3*t2+1)*xy[index, 1] + (t3-2*t2+t)*h*slopes[index]
                   + (-2*t3+3*t2)*xy[index+1, 1] + (t3-t2)*h*slopes[index+1], 0.0, 1.0)


def apply_free_curves(rgb, points):
    master = evaluate_curve(rgb, points["master"])
    return np.stack([evaluate_curve(master[..., i], points[channel])
                     for i, channel in enumerate(("r", "g", "b"))], axis=-1)
