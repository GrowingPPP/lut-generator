# AI 自动修图 · 技术设计

> 配套文档:[架构设计](./architecture.md) · [UI 设计](./ui-design.md) · [测试方案](./test-plan.md)
> 本文档给出可直接实施的接口签名、数据结构、阈值与算法。

---

## 1. 模块清单与依赖方向

```
backend/
├── photo/                       新增,纯计算层(不依赖 FastAPI / LLM / DB)
│   ├── __init__.py              导出 analyze / diagnose / render_lut
│   ├── types.py                 PhotoStats / Issue / StepReport 等数据结构
│   ├── stats.py                 图像 → PhotoStats
│   ├── quality.py               PhotoStats → [Issue],阈值集中在此
│   ├── render.py                LUT + 图像 → 渲染结果(向量化三线性)
│   └── fixtures.py              合成测试图生成器(测试与演示共用)
├── agent/
│   ├── auto.py                  新增:编排(优化 → 硬校验 → 风格 → 复检)
│   ├── schemas.py               扩展:新增两个工具 schema
│   └── llm.py                   复用,不新增调用方式
├── api/
│   ├── main.py                  新增 /api/auto/grade 路由
│   └── models.py                新增(可选):从 main.py 拆出的 pydantic 模型
└── tests/
    ├── test_photo_stats.py      新增
    ├── test_photo_quality.py    新增
    ├── test_auto_grade.py       新增
    └── test_auto_api.py         新增

frontend/src/
├── components/
│   ├── AutoRetouchBar.jsx       新增:按钮 + 风格输入 + 进度
│   ├── AutoRetouchReport.jsx    新增:修改说明面板(原理解释 / 风格理解 / 否决项 / 复检)
│   └── …
├── lib/api.js                   新增 autoGrade()
├── lib/autoGrade.js             新增:请求构造 + 响应归一化(纯函数,可测)
├── App.jsx                      接入上述组件
└── App.css                      新增样式(沿用现有设计令牌)
```

**依赖方向(不可逆)**

```
api  ──→  agent.auto  ──→  photo.*  ──→  numpy / PIL
 │            │
 │            └──→  agent.llm ──→ openai
 └──→  storage.db
```

- `photo/*` **不得** import fastapi / openai / storage。它是纯函数层,必须能脱离一切框架单测。
- `agent/auto.py` 是唯一把「测量」「LLM」「引擎」缝在一起的地方;它不碰 HTTP。
- 这样 `photo/*` 的测试不需要 API key、不需要数据库、不需要网络。

---

## 2. 数据契约

### 2.1 `photo/types.py`

```python
from dataclasses import dataclass, field
from typing import Literal

@dataclass(frozen=True, slots=True)
class PhotoStats:
    """一张照片的客观测量结果。全部为确定性数值,同一输入必然同一输出。"""
    width: int
    height: int
    sampled_px: int                       # 实际参与统计的像素数(降采样后)

    # 亮度(Rec.709 加权,线性化前,即编码值域 0..1)
    lum_p1: float
    lum_p5: float
    lum_p50: float
    lum_p95: float
    lum_p99: float

    # 裁剪
    highlight_clip_pct: float             # any(channel) > 0.98 的像素占比 ×100
    shadow_clip_pct: float                # all(channel) < 0.02 的像素占比 ×100

    # 通道与色偏
    rgb_mean: tuple[float, float, float]
    rgb_median: tuple[float, float, float]
    shadow_cast: tuple[float, float, float]      # 最暗 20% 像素的通道均值
    highlight_cast: tuple[float, float, float]   # 最亮 20% 像素的通道均值
    gray_world_dev: float                 # 灰世界偏差,0 = 完美中性

    # 饱和度
    saturation_mean: float                # mean((max-min)/max)
    saturation_p95: float

    # 主体保护
    skin_ratio: float                     # 肤色像素占比 0..1
    skin_mean_rgb: tuple[float, float, float] | None   # 无肤色时为 None
    skin_lum_p50: float | None

    # 画质
    noise_sigma: float                    # 高频残差标准差,估计噪点水平


@dataclass(frozen=True, slots=True)
class Issue:
    code: str
    severity: float                       # 0..1
    evidence: str                         # 给人看的证据,直接进 UI
    suggested: dict                       # 建议的参数方向(仅提示,不直接采用)


@dataclass(slots=True)
class StepReport:
    stage: Literal["optimize", "style"]
    round: int
    diagnosis: str                        # 模型的一句话诊断
    proposed: dict                        # 模型提议的增量
    applied: bool
    stats_after: PhotoStats | None
    rejections: list[str] = field(default_factory=list)   # 被硬校验拒绝的原因
    usage: dict = field(default_factory=dict)
```

### 2.2 `AutoGradeResult`(`agent/auto.py`)

```python
@dataclass(slots=True)
class AutoGradeResult:
    params: dict                          # 最终参数,可直接喂 LutParamsModel
    steps: list[StepReport]
    issues: list[Issue]                   # ② 的判定结果,UI 用于展示「诊断出什么」
    style_params: dict | None             # ⑥a 抽到的风格目标值,UI 用于让用户核对
    review: str | None                    # ⑦ 复检意见
    degraded: bool                        # True = 未达标,已采用保守解
    usage: dict                           # 累计 token
```

---

## 3. `photo/stats.py`

### 3.1 接口

```python
MAX_ANALYZE_SIDE = 512      # 统计前降采样到此长边;仅影响精度不影响判据
SKIN_CB_RANGE = (77, 127)   # YCbCr 经典肤色区间(Chai & Ngan)
SKIN_CR_RANGE = (133, 173)
CLIP_HIGH = 0.98
CLIP_LOW = 0.02
DARK_Q, BRIGHT_Q = 0.20, 0.80

def load_image(data: bytes) -> np.ndarray:
    """bytes → float32 RGB,值域 0..1,EXIF 方向已应用。
    抛 UnsupportedImageError / CorruptImageError。"""

def downsample(img: np.ndarray, max_side: int = MAX_ANALYZE_SIDE) -> np.ndarray:
    """长边超过 max_side 时用 PIL LANCZOS 等比缩小。"""

def analyze(img: np.ndarray) -> PhotoStats:
    """完整测量。img 为 float32 HxWx3,值域 0..1(不裁剪,允许超界以暴露问题)。"""

def to_prompt_dict(stats: PhotoStats) -> dict:
    """转成喂给 LLM 的紧凑字典(只保留有诊断价值的字段,控制 token)。"""
```

### 3.2 算法要点

| 指标 | 算法 | 注意 |
|---|---|---|
| 亮度 | `lum = 0.2126R + 0.7152G + 0.0722B`(直接对编码值加权) | **不要先线性化**:判据阈值是按编码值标定的,线性化后阈值全变 |
| 分位数 | `np.percentile(lum, [1,5,50,95,99])` | 在降采样后的图上算,分位数对采样密度不敏感 |
| 高光裁剪 | `(rgb.max(axis=2) > 0.98).mean()*100` | **任一通道**溢出即算,单通道溢出也会丢色 |
| 阴影裁剪 | `(rgb.max(axis=2) < 0.02).mean()*100` | 用 `max` 而非 `all`:三通道都死黑才算压死 |
| 暗部/亮部色偏 | 按 `lum` 排序取最暗/最亮 20%,各自求通道均值 | 分段看色偏比全局准:整体偏暖可能是夕阳光,暗部偏蓝才是白平衡问题 |
| 灰世界偏差 | `std(rgb_mean / rgb_mean.mean())` | 0 表示三通道均值相等 |
| 饱和度 | `((mx-mn)/np.maximum(mx,1e-6)).mean()` | 与引擎 `apply_vibrance` 的公式保持一致,便于对齐 |
| 肤色 | RGB → YCbCr(`BT.601`),落在 CB/CR 区间且 `Y` 在 40..235 内 | 阈值是经验值,**必须用合成图锁定回归**(见测试方案) |
| 噪点 | 图像与 3×3 均值滤波之差的稳健标准差(`1.4826 × MAD`) | 用 MAD 而非 std,避免被真实边缘污染 |

### 3.3 性能预算

- 降采样到 512×~340 ≈ 17 万像素,全部指标一次算完 **< 30 ms**。
- 单次自动修图最多调用 `analyze` **约 6 次**(原图 + 每轮 + 风格轮 + 复检前),合计 < 200 ms,可忽略。

---

## 4. 调色参数全集(30 个)与 LUT 能力边界

### 能做的:逐点运算 `f(r,g,b)`

一个 3D LUT 只能表达**逐点**色彩映射 —— 引擎的 `build_grid()` 只喂三个通道值,签名里
没有位置 `(x,y)`、也没有邻域像素。当前 30 个参数**全部**属于这一类:

| 组 | 参数 | 说明 |
|---|---|---|
| 单张校正 | `temp` `tint` `exposure` | 相对冷暖、绿洋红与曝光(线性域) |
| 影调 | `contrast` `contrast_pivot` `highlights` `shadows` `whites` `blacks` `curve` | 对比中心、分区提压、黑白部层次、S 曲线 |
| 色彩 | `saturation` `vibrance` `hue` | 饱和度、自然饱和度、色相旋转 |
| 局部色彩 | `selective_hue_center/width/shift` `selective_saturation` | 目标色相范围内的色相与饱和度 |
| 分离色调 | `split_shadow_hue/sat` `split_mid_hue/sat` `split_highlight_hue/sat` `split_balance` | 阴影、中间调与高光染色 |
| 分通道 | `lift` `gamma` `gain`(各 3 通道) | RGB 偏移、中间调与增益 |
| 基准与风格 | `base_photo_style` `tone_map` `look_strength` | 输入/显示转换与创意风格强度 |

### 不能做的:位置相关与邻域相关

| 类别 | 例子 | 为什么不行 |
|---|---|---|
| 位置相关 | 暗角、渐变滤镜、径向滤镜、蒙版、局部画笔、修复/仿制 | 同一颜色在不同位置必须映射到同一输出,LUT 无法区分位置 |
| 邻域相关 | 清晰度、纹理、去雾、锐化、降噪、颗粒 | LUT 对每个像素独立作用,看不到邻居 |

**这两类是类型不匹配,不是精度问题** —— 加参数、换更大网格都无法解决。相机厂商可通过 `.cube` 之外的专用元数据另外控制颗粒或锐化；这不改变 3D LUT 的逐点性质。
边界清晰带来一个实际好处:所有参数都能烘进**单个** 33³ `.cube`,机内烧录与后期软件两条路都成立。

### 新增算子的实现约束(实测得出)

1. **掩码必须平滑,不能有硬阈值。** 33³ 网格 + 三线性插值在曲线拐点处会产生插值误差:
   平滑掩码下最大约 2/255 级(不可见),换硬阈值会跳到 40+/255(明显串色)。
   平滑掩码同时也是修图上更正确的做法 —— 硬阈值的调色会产生色带。
2. **算子间有依赖,顺序不能随意改。** 现有 5 步(`contrast → gamma → saturation → hue → vibrance`)
   的相对顺序一旦变动,已保存 LUT 的结果就会漂移。新算子统一追加在其后
   (`apply_tone_ops`),`test_existing_op_order_unchanged` 锁住这一点。
3. **`split_balance` 的方向**:值越大**高光染色覆盖越广**(与 ACR 分离色调的 Balance 方向一致)。

### 33³ 网格的精度包络(实测标定)

误差定义为「33³ LUT 三线性重建 vs 更密网格直接求值」的最大差,单位 8bit 级:

| 场景 | 最大误差 | 判定 |
|---|---|---|
| 单算子拉满(`highlights` / `curve` / `whites` / `blacks`) | 0.2 ~ 1.6 | 不可见 |
| 单算子拉满(`shadows` / `contrast` / `saturation`) | 3.2 ~ 3.7 | 不可见 |
| 真实调色方案(日系清透 / 电影青橙 / 复古胶片 / 风光 / 人像) | 0.15 ~ 3.2 | 不可见 |
| 重口味叠加(对比 0.4 + 饱和 0.35 + 曲线 0.4 + 高光阴影 ±0.6) | ~7 | 可接受 |
| 全部拉满的对抗性组合 | 20 ~ 40 | **已知限制** |

**已知限制的归因**:逐个剔除实验表明主导误差的是**既有的 `contrast` 与 `saturation`**
(各自贡献 ~6/255),而本次新增的算子几乎不贡献(`highlights` 单独剔除时误差变化为 0)。
所以**不通过收紧新参数范围来解决** —— 那既改变不了主因,又会静默改变已保存 LUT 的行为。
若将来确实需要更高精度,唯一途径是把网格从 33³ 提到 65³,但那会失去松下机内兼容。

> 回归防线:`tests/test_tone_regions.py` 里有 `GRADING_RECIPES` 精度包络测试。
> **放宽任何滑杆范围之前,先跑它看误差是否退化。**

---

## 5. `photo/quality.py`

### 5.1 阈值常量(集中在此,便于调参与回归)

```python
# 亮度
UNDER_EXPOSED_MEDIAN      = 0.32      # lum_p50 低于此 → 欠曝
OVER_EXPOSED_MEDIAN       = 0.68      # lum_p50 高于此 → 过曝
LOW_CONTRAST_RANGE        = 0.30      # (p95-p5) 小于此 → 低对比
FLAT_HAZE_MEDIAN          = 0.42      # p50 偏中且区间窄 → 灰雾
FLAT_HAZE_RANGE           = 0.38
EXPOSURE_TARGET           = (0.40, 0.55)   # 建议的 p50 落点,保守解用

# 裁剪
CLIP_WARN_PCT             = 1.5
CLIP_SEVERE_PCT           = 4.0

# 色偏
GRAY_WORLD_WARN           = 0.06
SHADOW_CAST_WARN          = 0.05      # 暗部通道相对差

# 饱和度
OVER_SATURATED_MEAN       = 0.45
OVER_SATURATED_P95        = 0.70

# 画质
NOISE_SIGMA_WARN          = 0.030     # 超过则限制 contrast/saturation 上限
```

### 5.2 接口

```python
def diagnose(stats: PhotoStats) -> list[Issue]:
    """按固定顺序产出问题清单:欠曝 → 过曝 → 低对比 → 灰雾 → 色偏 → 过饱和 → 裁剪。
    顺序即 UI 展示顺序。severity 用于排序与展示强调。"""

def limits_for(stats: PhotoStats) -> dict:
    """由画质推导出的硬校验上限。噪点高时收紧 contrast/saturation。
    返回形如 {"max_contrast_delta": 0.35, "max_saturation_delta": 0.25}。"""
```

### 5.3 诊断规则的写法约定

每个 `Issue` 的 `evidence` 必须是**可读的证据句**,而不是代码:

```python
# 好
Issue(code="under_exposed", severity=0.62,
      evidence=f"中间调偏暗(lum_p50={stats.lum_p50:.3f},建议 0.40~0.55)",
      suggested={"exposure": +0.4})
# 坏 —— 用户看不懂,也无法验证
Issue(code="under_exposed", severity=0.62, evidence="p50 too low", suggested={})
```

理由:`evidence` 会**原样出现在 UI 的「修改说明」里**。这一层的输出同时服务于「喂 LLM」和「给人看」两个目的,不要写两份文案。

---

## 6. `photo/render.py`

```python
def render_lut(lut: np.ndarray, img: np.ndarray) -> np.ndarray:
    """把 (N,N,N,3) 的 LUT 应用到 HxWx3 图像,向量化三线性采样。
    采样语义必须与前端 shader 完全一致(含 0.5/N 半像素偏移),
    否则「模型看到的图」与「用户预览的图」会有偏差。

    实测:240×320 图 18 ms;无需 scipy。
    """

def to_data_url(img: np.ndarray, max_side: int = 768, quality: int = 80) -> str:
    """float RGB → JPEG base64 data URL,供⑦发给模型。
    max_side 默认 768:体积与细节的折中(实测 768px q80 ≈ 246 KB)。"""

def lut_from_params(params: dict) -> np.ndarray:
    """薄封装:lut_params_from_dict + generate_lut(33)。6.5 ms。"""
```

**为什么手写而不是用 `scipy.ndimage.map_coordinates`**:实测 numpy 版本 18 ms 已足够,且能精确复刻前端 shader 的半像素偏移(`coord = c*(N-1)/N + 0.5/N`)。

---

## 7. `agent/auto.py`(核心编排)

### 7.1 主流程

```python
MAX_OPTIMIZE_ROUNDS = 2     # 优化阶段最多几轮(不含风格)
MAX_STYLE_ROUNDS    = 1

def auto_grade(
    img: np.ndarray,
    base_params: dict,
    style: str | None,
    client,
    *,
    use_vision: bool = True,
    max_rounds: int = MAX_OPTIMIZE_ROUNDS,
) -> AutoGradeResult:
    ...
```

伪代码:

```
stats0 = analyze(img)
issues = diagnose(stats0)
params = dict(base_params)                      # 增量基准
steps  = []

# ---------- 阶段 A:优化 ----------
for r in range(1, max_rounds+1):
    proposed = propose_correction(client, params, stats, issues, rejected_history)
    if not proposed or proposed.is_empty():
        break
    candidate = merge(params, proposed.params)   # 增量叠加
    ok, reasons = check_hard_rules(stats_current, candidate, stats0, limits)
    if not ok:
        rejected_history.append((proposed, reasons))
        steps.append(StepReport(applied=False, rejections=reasons, ...))
        continue                                  # 带原因重提议
    params = candidate
    stats_current = analyze(render_lut(lut_from_params(params), img))
    steps.append(StepReport(applied=True, stats_after=stats_current, ...))
    if converged(stats_current):                  # 所有 Issue 缓解
        break
else:
    # 轮数用尽仍未达标 → 保守解
    params, degraded = conservative_solution(stats0, base_params)

# ---------- 阶段 B:风格(可选) ----------
if style:
    style_params = extract_style(client, style)   # 复用 ExtractResult schema
    candidate = merge(params, style_params)
    ok, reasons = check_hard_rules(...)           # 风格同样过硬校验
    params = candidate if ok else params
    steps.append(StepReport(stage="style", ...))

# ---------- ⑦ 主观复检 ----------
review = None
if use_vision:
    before = to_data_url(img)
    after  = to_data_url(render_lut(lut_from_params(params), img))
    review = vision_review(client, before, after, style)

return AutoGradeResult(params, steps, issues, style_params, review, degraded, usage)
```

### 7.2 硬校验

```python
def check_hard_rules(
    stats_before: PhotoStats,
    candidate_params: dict,
    stats_baseline: PhotoStats,
    limits: dict,
) -> tuple[bool, list[str]]:
```

规则表(全部为**确定性**断言,阈值来自 §4.1 与 `limits_for`):

| # | 规则 | 拒绝理由文案 |
|---|---|---|
| R1 | 高光裁剪增幅 ≤ +0.5% | `高光溢出从 1.2% 增到 3.4%,超出允许范围` |
| R2 | 阴影裁剪增幅 ≤ +0.5% | `阴影压死比例从 0.3% 增到 1.9%` |
| R3 | 有肤色(`skin_ratio > 0.02`)时肤色三通道漂移各 ≤ 0.06 | `肤色偏移过大(皮肤均值的 R 通道移动 0.09)` |
| R4 | `saturation_mean` ≤ 基线 × 1.6 | `饱和度过高,画面会失真` |
| R5 | 单轮 `|Δexposure|` ≤ 1.0 EV | `单次曝光调整超过 1 EV,过于激进` |
| R6 | 全部参数在 `LutParams` 合法区间内 | `参数超出允许范围` |
| R7 | 噪点高时 `|Δcontrast| ≤ limits["max_contrast_delta"]` | `照片噪点较高,不宜再增加对比度` |

**关键**:`stats_before` 用**紧邻的上一轮**指标,`stats_baseline` 用**最初**的指标。R1/R2 对比前者(防止某一轮突然造成溢出),R4 对比后者(防止多轮累积把饱和度推上天)。这两者混用会导致 R4 被逐轮绕过。

### 7.3 保守解

轮数用尽仍未达标时**不返回坏结果**,改用规则层能确定的修正:

```python
def conservative_solution(stats: PhotoStats, base_params: dict) -> tuple[dict, bool]:
    """只做高置信度修正,且不依赖 LLM:
       - 曝光:把 lum_p50 拉向 EXPOSURE_TARGET 区间中点(限幅 ±0.6 EV)
       - 白平衡:按 gray_world_dev 的符号做小幅 temp/tint 修正(限幅 ±250K)
       - 其余参数一律保持用户原值
    返回 (params, True) —— 第二个值即 degraded 标记。
    """
```

**为什么这是对的兜底**:曝光与白平衡的修正是**可计算的**(相机自动测光就是同一原理),不需要模型判断。弱化模型让不确定性下降,同时保证有产出。返回 `degraded=True` 让 UI 如实告知。

实现时踩过两个坑,都已修掉:

1. **色温符号**:正 temp = 更暖(实测确认),所以偏暖图必须给**负** temp。早期写成
   `+b_minus_r`,方向完全反了 —— 越修越暖。
2. **保守解必须是「纯兜底」,不能在 LLM 修正之上叠加**。它自己就是一套完整的
   「曝光拉向目标 + 灰世界白平衡」;在 LLM 已应用过的基础上再跑一遍,会对同一目标
   **重复补偿**(实测把 0.3EV 的成果推到 0.6EV),既过冲又与「曝光相对基线 ≤1EV」
   的规则冲突。现在的契约是:**仅当 LLM 一步都没应用时才启用**;LLM 修了一部分但
   没修完时,保留成果并标记 `degraded`。

保守解还带一道**守卫**:只接受「问题数不增加」的迭代。实测在「偏暗且暗部偏蓝」的图上,
全局暖化会新增「整体偏暖」—— 兜底路径尤其不能越修越糟。

### 7.4 收敛判定

```python
def converged(stats: PhotoStats) -> bool:
    """所有 Issue 是否都已缓解到阈值内。用于提前结束,省一轮 LLM 调用。"""
    return len(diagnose(stats)) == 0
```

### 7.5 两个新工具 schema

追加到 `agent/schemas.py`,复用现有 `build_tool_schema()` 的转换逻辑:

```python
CORRECTION_TOOL_NAME = "propose_correction"

class CorrectionProposal(BaseModel):
    """优化阶段的增量提议。范围取比 LutParams 更窄的「单轮合理区间」,
    单轮激进改动会被 §7.2 的 R5 拒绝,与其让模型白跑一轮不如在 schema 里就收窄。"""
    model_config = ConfigDict(extra="forbid")
    diagnosis: str = Field(..., description="一句话诊断:这张照片的主要问题")
    exposure: Optional[float] = Field(None, ge=-1, le=1, description="曝光增量,EV")
    contrast: Optional[float] = Field(None, ge=-0.5, le=0.5, description="对比度增量")
    temp: Optional[float] = Field(None, ge=-800, le=800, description="色温偏移增量,K,正=暖")
    tint: Optional[float] = Field(None, ge=-200, le=200, description="色调偏移增量,正=绿")
    saturation: Optional[float] = Field(None, ge=-0.5, le=0.5, description="饱和度增量")
    vibrance: Optional[float] = Field(None, ge=-0.5, le=0.5, description="自然饱和增量")
    lift: Optional[List[float]] = Field(None, min_length=3, max_length=3, description="暗部三通道增量")
    gamma: Optional[List[float]] = Field(None, min_length=3, max_length=3, description="中间调三通道增量")
    gain: Optional[List[float]] = Field(None, min_length=3, max_length=3, description="亮部三通道增量")
```

**刻意不包含 `base_photo_style`。** 它决定 LUT 的**输入侧**(照片线走 sRGB、V-Log 走视频线),换它等于换整条变换链路,而不是「调一点色」:

- 用户上传的是相机直出 JPEG,其基准由**相机当时的照片风格**决定,模型无法从像素可靠推断用户当时用了哪个风格,猜错会让整张图颜色系统性偏掉
- 它属于「用户需要在拍摄端决定」的事,不是修图能修的

因此 `base_photo_style` 在自动修图里**只读不改**(来自 `base_params`,原样透传)。

风格阶段**复用现有 `ExtractResult`**(架构设计 §3.3),不新增参数字典 —— 那里 `base_photo_style` 是允许的,因为用户可能明确说「按 V-Log 处理」。

风格阶段**复用现有 `ExtractResult`**(§3.3 of 架构文档),不新增参数字典。

`propose_correction` 的系统提示要点:

- 明确「你要给的是**增量**,不是绝对值」
- 明确「只改你判断有问题的地方,没问题就少给字段」
- **把 `issues` 与 `stats` 一起给它**:issues 告诉它「修什么」,stats 给它判断幅度
- 把上一轮被拒的原因(`rejections`)给它,避免重复同样的提议

---

## 8. API 详细契约

### 8.1 请求

```http
POST /api/auto/grade
Content-Type: multipart/form-data
Authorization: Bearer … 或 chroma_token cookie

file         必需   图片二进制。服务端校验实际内容而非 MIME
base_params  必需   JSON 字符串,LutParamsModel 全字段(前端传当前参数)
style        可选   自然语言风格描述,最长 200 字(超长截断并提示)
use_vision   可选   "true"/"false",默认 true
max_rounds   可选   1..3,默认 2
```

**`base_params` 必需,不用默认值兜底。** 缺失或非法直接 422 —— 因为增量语义下「用默认值」会把用户手调静默抹掉,这是不可接受的静默失败。

### 8.2 响应(200)

```json
{
  "params":        { "base_photo_style": "NAT", "temp": 120, "exposure": 0.25, "...": "..." },
  "issues": [
    { "code": "under_exposed", "severity": 0.62,
      "evidence": "中间调偏暗(lum_p50=0.286,建议 0.40~0.55)" }
  ],
  "steps": [
    { "stage": "optimize", "round": 1,
      "diagnosis": "画面低反差发灰、整体偏暖",
      "proposed": { "exposure": 0.25, "contrast": 0.45, "temp": -450 },
      "applied": true, "rejections": [],
      "stats_after": { "lum_p50": 0.412, "highlight_clip_pct": 0.0 } }
  ],
  "style_params":  { "temp": -100, "contrast": 0.1 },
  "review":        "修图后画面通透度提升,肤色保持自然…",
  "degraded":      false,
  "usage":         { "prompt_tokens": 1840, "completion_tokens": 620, "vision_calls": 1 }
}
```

### 8.3 错误

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 图片内容无法解码 / 格式不支持 | `{"detail": "不支持的图片格式,请用 JPEG/PNG/WebP"}` |
| 413 | 图片超过 32 MiB(对齐 API 限制) | `{"detail": "图片过大,请压缩到 32MB 以内"}` |
| 422 | `base_params` 缺失或字段非法 | FastAPI 默认校验错误体 |
| 502 | LLM 调用失败(超时/5xx) | `{"detail": "分析服务暂时不可用,请稍后重试"}` |
| 200 + `degraded=true` | 未达标但已给保守解 | 正常响应体 |

**约定**:`degraded` 是**业务状态**,不是错误,所以用 200 + 布尔标记,不用 4xx/5xx。前端必须显著提示。

### 8.4 落库

自动修图结果复用现有 `messages` 表存一条 `role="agent"` 记录:

- `content` = 人类可读的修改说明(由 `issues` + `steps` + `review` 拼装)
- `params_json` = 最终参数
- `cube_text` = **不写**(生成 LUT 由用户按需触发,避免又一次 0.9 MB 落库)

图片与 `preview_png_b64` **不落库**。

---

## 9. 前端技术细节

### 9.1 `lib/autoGrade.js`(纯函数,可单测)

```js
export function buildAutoGradeForm({ file, params, style, useVision = true }) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('base_params', JSON.stringify(params))
  if (style?.trim()) fd.append('style', style.trim())
  fd.append('use_vision', String(useVision))
  return fd
}

export function summarizeSteps(steps) {
  // → [{ icon, title, detail }] 供 UI 渲染,把技术字段翻译成中文
}

export function diffParams(before, after) {
  // → 只列出真正变化的字段,用于「本次调整」摘要
}
```

### 9.2 与现有预览的衔接

- 上传照片后,`usePreview` 里已有 `imageRef.current`(HTMLImageElement)。**直接复用它**,不要让用户重新上传。
- 自动修图前后对比**复用现有 `LUTRenderer` 的 slider 模式**,不新增渲染路径。
- 若用户还没上传照片:按钮禁用 + `title="请先上传样张"`。当前用的是内置合成图(`makeTestImage`),用它跑自动修图没有意义(它不是真实照片),必须在 UI 上区分。

### 9.3 状态机

```
idle ──点击──→ running(step 索引驱动进度)──→ done ──→ (继续手调)
  ↑                                              │
  └────────────── 撤销 ←─────────────────────────┘
                     │
                  error(展示 detail,可重试)
```

撤销实现:`pushUndo(params)` 在**发起请求前**保存快照,撤销时 `setParams(snapshot)`。与现有 `cubeText` 置空逻辑一致(参数一变,服务端 cube 文本失效)。

---

## 10. 可观测性与成本

| 指标 | 记录方式 |
|---|---|
| 每次自动修图的 token 与轮数 | 响应里的 `usage`;后端 logger 记一行结构化日志 |
| `degraded` 发生率 | 同上。**这是最重要的质量指标** —— 持续偏高说明阈值或提示有问题 |
| 硬校验拒绝率与拒绝原因分布 | `steps[].rejections` 聚合。若 R3(肤色)频繁触发,说明提示需要加强肤色保护 |
| 端到端耗时 | 目标 < 15 s(实测:统计 <30ms + 优化 5.3s + 复检 3.2s) |

**不做**:图片上传到第三方存储、用户照片的持久化。图片只在请求内存中存在。

---

## 11. 安全与隐私

| 项 | 措施 |
|---|---|
| 图片出境 | 复用 `use_vision` 开关;关闭后完全不发图(仅发数字) |
| 图片落库 | **不落库**。仅 `preview_png_b64` 在响应中回传 |
| 上传体积 | 服务端限制 32 MiB(与模型 API 限制对齐),超出 413 |
| 解码炸弹 | 先读头部尺寸,像素数超过 8000×8000 直接拒;再解码 |
| EXIF | 分析前应用方向;**不回传** EXIF(避免泄露 GPS) |
| 风格描述注入 | 风格文本只进 user 消息、不过系统提示;长度截断 200 字 |
| 速率 | 复用现有认证;自动修图成本高,建议单独加每用户限流(如 20 次/小时) |
