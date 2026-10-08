"""渲染层测试。

关键断言是「采样语义与前端 shader 一致」—— 不一致会导致
「模型看到的渲染图」与「用户预览图」有系统性偏差,视觉复检就失去意义。
"""
import base64
import io

import numpy as np
import pytest
from PIL import Image

from lut_engine import build_grid
from photo import render as R
from photo.fixtures import make_fixture


def _identity_lut(n=33):
    """精确恒等 LUT:lut[r,g,b] = (r/(n-1), g/(n-1), b/(n-1))。"""
    coords = np.linspace(0.0, 1.0, n, dtype=np.float32)
    r, g, b = np.meshgrid(coords, coords, coords, indexing="ij")
    return np.stack([r, g, b], axis=-1).astype(np.float32)


# ---- 采样正确性 ----

def test_identity_lut_is_noop_on_dense_grid():
    """恒等 LUT 渲染后必须与原图一致 —— 采样公式正确性的根断言。"""
    n = 33
    lut = _identity_lut(n)
    # 用密集随机点(不是网格点),才能真正检验插值
    rng = np.random.RandomState(7)
    img = rng.rand(64, 64, 3).astype(np.float32)
    out = R.render_lut(lut, img)
    assert np.abs(out - img).max() < 1e-6


def test_matches_shader_centered_formula():
    """与前端 shader 的 coord = c*(n-1)/n + 0.5/n 必须一致。

    用一个线性斜坡 LUT 检验:若半像素偏移写错,结果会出现系统性偏移。
    """
    n = 4
    lut = np.zeros((n, n, n, 3), np.float32)
    coords = np.linspace(0, 1, n, dtype=np.float32)
    # R 通道恒等,G/B 常量
    for i in range(n):
        lut[i, :, :, 0] = coords[i]
    lut[..., 1] = 0.25
    lut[..., 2] = 0.75

    for v in (0.0, 0.13, 0.5, 0.87, 1.0):
        img = np.full((1, 1, 3), v, np.float32)
        out = R.render_lut(lut, img)[0, 0]
        assert out[0] == pytest.approx(v, abs=1e-6), f"R 通道在 {v} 处偏移"
        assert out[1] == pytest.approx(0.25, abs=1e-6)
        assert out[2] == pytest.approx(0.75, abs=1e-6)


def test_clamps_out_of_range_input():
    """CLAMP_TO_EDGE:超出 [0,1] 的输入夹到边界,不外推也不回绕。"""
    lut = _identity_lut(5)
    img = np.array([[[-0.5, 0.5, 1.8]]], np.float32)
    out = R.render_lut(lut, img)
    assert out[0, 0, 0] == pytest.approx(0.0, abs=1e-6)
    assert out[0, 0, 2] == pytest.approx(1.0, abs=1e-6)


def test_render_is_deterministic():
    lut = R.lut_from_params({"contrast": 0.3, "shadows": 0.4})
    img = make_fixture("neutral")
    assert np.array_equal(R.render_lut(lut, img), R.render_lut(lut, img))


def test_render_output_stays_in_range():
    img = make_fixture("neutral")
    for params in ({"exposure": 3.0}, {"exposure": -3.0},
                   {"contrast": 1.0, "saturation": 1.0, "curve": 1.0},
                   {"highlights": 1.0, "shadows": 1.0, "whites": 1.0, "blacks": 1.0}):
        out = R.render_lut(R.lut_from_params(params), img)
        assert out.min() >= 0.0 and out.max() <= 1.0, f"{params} 输出越界"


def test_rejects_bad_shapes():
    with pytest.raises(ValueError):
        R.render_lut(np.zeros((2, 2, 2, 3), np.float32), np.zeros((4, 4), np.float32))
    with pytest.raises(ValueError):
        R.render_lut(np.zeros((3, 3, 3, 2), np.float32), np.zeros((4, 4, 3), np.float32))


def test_render_preserves_gray_axis():
    """只调饱和度的 LUT 不应改动中性灰 —— 灰轴不动是色彩变换的基本约束。"""
    lut = R.lut_from_params({"saturation": 0.8})
    gray = np.full((5, 5, 3), 0.42, np.float32)
    out = R.render_lut(lut, gray)
    assert np.abs(out - 0.42).max() < 1e-5


# ---- performance ----

def test_render_performance_budget():
    """单次渲染要在几十毫秒内 —— 闭环里每轮都要渲染一次。"""
    import time
    lut = R.lut_from_params({"contrast": 0.3})
    img = make_fixture("neutral", size=(240, 320))
    t0 = time.time()
    R.render_lut(lut, img)
    assert (time.time() - t0) < 0.2


# ---- to_data_url ----

def test_data_url_is_valid_jpeg_and_bounded():
    img = make_fixture("neutral", size=(1080, 1920))
    url = R.to_data_url(img)
    assert url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(url.split(",", 1)[1])
    assert len(raw) < 1_500_000, f"压缩后仍达 {len(raw)} 字节"
    Image.open(io.BytesIO(raw)).verify()


def test_data_url_respects_max_side():
    img = make_fixture("neutral", size=(400, 1600))
    url = R.to_data_url(img, max_side=400)
    raw = base64.b64decode(url.split(",", 1)[1])
    decoded = Image.open(io.BytesIO(raw))
    assert max(decoded.size) == 400
    assert abs(decoded.size[0] / decoded.size[1] - 1600 / 400) < 0.02


def test_data_url_noop_when_small():
    img = make_fixture("neutral", size=(100, 120))
    url = R.to_data_url(img, max_side=768)
    decoded = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert decoded.size == (120, 100)


# ---- side_by_side ----

def test_side_by_side_shape_and_seam():
    a = make_fixture("neutral", size=(60, 80))
    b = np.clip(a * 1.1, 0, 1)
    out = R.side_by_side(a, b, gap=12)
    assert out.shape == (60, 80 * 2 + 12, 3)
    assert np.allclose(out[:, :80], a, atol=1e-6)
    assert np.allclose(out[:, 92:], b, atol=1e-6)
    assert np.allclose(out[:, 80:92], 0.08, atol=1e-6), "中缝应为暗灰"


def test_side_by_side_rejects_mismatch():
    with pytest.raises(ValueError):
        R.side_by_side(make_fixture("neutral", size=(10, 20)),
                       make_fixture("neutral", size=(10, 30)))


# ---- lut_from_params 与引擎一致 ----

def test_lut_from_params_matches_engine():
    from lut_engine import generate_lut, lut_params_from_dict
    params = {"contrast": 0.25, "shadows": 0.3, "temp": 200}
    assert np.array_equal(
        R.lut_from_params(params),
        generate_lut(lut_params_from_dict(params), size=33),
    )


def test_rendered_result_equals_lut_lookup_at_grid_points():
    """在网格点上,渲染结果必须精确等于 LUT 对应项(插值不引入偏差)。"""
    lut = R.lut_from_params({"curve": 0.5, "saturation": 0.3})
    n = lut.shape[0]
    coords = np.linspace(0, 1, n, dtype=np.float32)
    img = np.zeros((n, n * n, 3), np.float32)
    # 构造所有 (r,g,b) 网格组合
    idx = 0
    for r in range(n):
        for g in range(n):
            img[r, g * n:(g + 1) * n, 0] = coords[r]
            img[r, g * n:(g + 1) * n, 1] = coords[g]
            img[r, g * n:(g + 1) * n, 2] = coords
    out = R.render_lut(lut, img)
    expected_r = np.zeros_like(img)
    for r in range(n):
        for g in range(n):
            expected_r[r, g * n:(g + 1) * n] = lut[r, g, :, :]
    assert np.abs(out - expected_r).max() < 1e-5


# ---- 与前端 shader 的采样对拍 ----
#
# 采样语义在两侧各写了一遍(Python 用 numpy,前端用 GLSL),这正是会漂移的地方:
# 一旦不一致,「模型看到的渲染图」与「用户预览图」就会有系统性偏差,视觉复检失去意义。

def test_matches_frontend_shader_sampling():
    """用 node 直接执行前端 shader 的采样公式,与 Python 实现逐点比对。

    前端公式来自 frontend/src/lib/lutPreview.js 的 FRAG:
        float s = (lutSize - 1.0) / lutSize;
        vec3 coord = c * s + 0.5 / lutSize;
    这里在 JS 里用完全相同的算式做 CPU 版三线性插值。
    """
    import json
    import shutil
    import subprocess
    from pathlib import Path

    node = shutil.which("node")
    if node is None:
        pytest.skip("未安装 node,跳过前后端采样对拍")

    root = Path(__file__).resolve().parent.parent.parent
    js = r"""
const N = 33;
const coords = Array.from({length: N}, (_, i) => i / (N - 1));
// 造一个非线性 LUT(纯恒等会掩盖采样错误)
function lutAt(r, g, b) {
  const x = coords[r], y = coords[g], z = coords[b];
  return [
    Math.min(1, Math.max(0, x * 0.8 + y * 0.15 + z * 0.05)),
    Math.min(1, Math.max(0, Math.pow((x + y) / 2, 1.4))),
    Math.min(1, Math.max(0, z * 0.6 + x * 0.4)),
  ];
}
function sampleShader(c) {
  const n = N, s = (n - 1.0) / n;
  const coord = c.map(v => v * s + 0.5 / n);
  const pos = coord.map(v => v * n - 0.5);
  const i0 = pos.map(Math.floor);
  const f = pos.map((v, k) => v - i0[k]);
  const cl = v => Math.max(0, Math.min(n - 1, v));
  const out = [0, 0, 0];
  for (let dz = 0; dz < 2; dz++)
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
        const v = lutAt(cl(i0[0] + dx), cl(i0[1] + dy), cl(i0[2] + dz));
        out[0] += v[0] * w; out[1] += v[1] * w; out[2] += v[2] * w;
      }
  return out;
}
const pts = [];
for (let i = 0; i < 200; i++) {
  // 固定伪随机,保证两侧输入一致
  const r = ((i * 7919) % 1000) / 1000, g = ((i * 104729) % 997) / 997, b = ((i * 1299709) % 991) / 991;
  pts.push([r, g, b, sampleShader([r, g, b])]);
}
process.stdout.write(JSON.stringify(pts));
"""
    proc = subprocess.run([node, "-e", js], capture_output=True, text=True, cwd=str(root))
    assert proc.returncode == 0, f"node 执行失败:{proc.stderr[:400]}"
    pts = json.loads(proc.stdout)

    # 用同一公式在 Python 侧造 LUT 并渲染
    n = 33
    coords = np.linspace(0.0, 1.0, n, dtype=np.float32)
    rr, gg, bb = np.meshgrid(coords, coords, coords, indexing="ij")
    lut = np.stack([
        np.clip(rr * 0.8 + gg * 0.15 + bb * 0.05, 0, 1),
        np.clip(((rr + gg) / 2.0) ** 1.4, 0, 1),
        np.clip(bb * 0.6 + rr * 0.4, 0, 1),
    ], axis=-1).astype(np.float32)

    want = np.array([p[3] for p in pts], np.float32).reshape(1, -1, 3)
    got = R.render_lut(lut, np.array([p[:3] for p in pts], np.float32).reshape(1, -1, 3))
    err = np.abs(got - want).max()
    assert err < 1e-5, f"前后端采样语义不一致,最大偏差 {err:.2e}"
