# AI 自动修图 · 测试方案

> 配套文档:[架构设计](./architecture.md) · [技术设计](./technical.md) · [UI 设计](./ui-design.md)
> 目标:让「测量是否准确」「硬校验是否真的拦得住」「增量语义是否真的增量」这三件事不依赖人工肉眼判断。

---

## 1. 测试分层与原则

| 层 | 依赖 | 是否需要 API key | 是否需要 DB | 目标 |
|---|---|---|---|---|
| L1 `stats` / `quality` / `render` | numpy + PIL | 否 | 否 | 数值正确、确定性 |
| L2 硬校验 | 纯函数 | 否 | 否 | **拦得住** |
| L3 `auto_grade` 编排 | 桩 LLM | 否 | 否 | 契约、增量语义、降级路径 |
| L4 API | TestClient | 否 | 是(复用现有 MySQL 测试库) | 状态码、参数校验 |
| L5 前端纯函数 | node 内置 `node:test` | 否 | 否 | 表单构造、摘要翻译 |
| L6 端到端 | Playwright + 桩 | 否 | 是 | 真实交互链路 |

**贯穿原则**

1. **默认不打真实 LLM。** 只有人工触发的 smoke 脚本打真接口(§7),CI 与日常 `make test` 全走桩。
2. **L1 是地基。** 测量算错了,上面所有断言都在验证一个错误的世界。所以 L1 必须断言**具体数值**,不能只断言「不抛异常」。
3. **阈值必须有边界测试。** `quality.py` 里每个常量都要有「刚好触发」与「刚好不触发」两例,否则改阈值时无人知道影响面。

---

## 2. L1:测量层

### 2.1 合成测试图(`backend/photo/fixtures.py`)

真实照片不适合做断言(数值不稳定、体积大、版权问题)。用程序生成**带已知缺陷**的图:

```python
def make_fixture(kind: str, size=(360, 480)) -> np.ndarray:
    """返回 float32 HxWx3,值域 0..1,带确定性随机种子。
    kind:
      neutral          中性灰阶渐变 + 少量彩色块(基准)
      under_exposed    整体偏暗(lum_p50 ≈ 0.22)
      over_exposed     整体偏亮(lum_p50 ≈ 0.78)
      low_contrast     动态范围窄(≈ 0.35~0.55)
      flat_haze        区间窄且中调偏灰(灰雾)
      warm_cast        三通道整体偏暖(R-B ≈ +0.15)
      cool_cast        偏冷
      shadow_blue      仅暗部偏蓝(模拟白平衡问题)
      over_saturated   高饱和(饱和均值 > 0.5)
      highlight_clip   大面积高光溢出(>5%)
      skin_tone        含一块标准肤色(便于断言 skin_ratio)
      skin_dark        深肤色(防止肤色检测只对浅肤色有效)
      noisy            叠加已知 sigma 的高斯噪点
    """
```

**为什么必须自己做 fixtures**:上面每种缺陷都对应一个 `Issue`。只有输入可控,才能断言「欠曝图必然产出 `under_exposed`」而不会因为照片换一张就红。

### 2.2 断言样例

```python
def test_under_exposed_detected():
    s = analyze(make_fixture("under_exposed"))
    assert s.lum_p50 < 0.30
    codes = {i.code for i in diagnose(s)}
    assert "under_exposed" in codes

def test_neutral_has_no_exposure_issue():
    s = analyze(make_fixture("neutral"))
    codes = {i.code for i in diagnose(s)}
    assert "under_exposed" not in codes and "over_exposed" not in codes

def test_warm_cast_measured_with_correct_sign():
    s = analyze(make_fixture("warm_cast"))
    assert s.rgb_mean[0] - s.rgb_mean[2] > 0.10   # R 明显高于 B
    assert s.gray_world_dev > GRAY_WORLD_WARN

def test_shadow_cast_isolates_dark_regions():
    """全局可能中性,但暗部偏蓝 —— 分段测量必须能抓到,否则白平衡诊断会漏。"""
    s = analyze(make_fixture("shadow_blue"))
    b_r = s.shadow_cast[2] - s.shadow_cast[0]
    assert b_r > SHADOW_CAST_WARN

def test_skin_detection_covers_dark_skin():
    assert analyze(make_fixture("skin_tone")).skin_ratio > 0.02
    assert analyze(make_fixture("skin_dark")).skin_ratio > 0.02   # 不能只认浅肤色

def test_noise_estimate_tracks_injected_sigma():
    quiet = analyze(make_fixture("neutral")).noise_sigma
    noisy = analyze(make_fixture("noisy")).noise_sigma
    assert noisy > quiet * 2

def test_analyze_is_deterministic():
    img = make_fixture("neutral")
    assert analyze(img) == analyze(img)      # dataclass 值相等
```

### 2.3 确定性契约

`PhotoStats` 是 `frozen` dataclass,**值相等**才有意义。这条测试锁住「同一输入必然同一输出」,是后续所有回归的基础。

### 2.4 `to_prompt_dict` 的紧凑性

```python
def test_prompt_dict_is_compact():
    d = to_prompt_dict(analyze(make_fixture("neutral")))
    assert len(d) <= 14                     # 控制 token
    assert all(not isinstance(v, float) or round(v, 3) == v for v in d.values())
```

理由:这个 dict 每次调用都进 prompt。字段膨胀是无声的成本泄漏,用断言挡住。

---

## 3. L1:`render.py`

```python
def test_identity_lut_is_noop():
    """恒等 LUT 渲染后应与原图逐像素一致(容差内)。这是采样正确性的根断言。"""
    lut = lut_from_params({})               # 默认参数 = 恒等变换
    img = make_fixture("neutral")
    out = render_lut(lut, img)
    assert np.allclose(out, img, atol=2e-3)

def test_matches_frontend_sampling_semantics():
    """采样必须含 0.5/N 半像素偏移,与前端 shader 一致。
    用一个已知的线性斜坡 LUT 验证:若偏移写错,结果会有系统性偏移。"""
    n = 3
    lut = np.zeros((n, n, n, 3), np.float32)
    for r in range(n):
        lut[r, :, :, 0] = r / (n - 1)        # R 通道恒等
    img = np.full((4, 4, 3), 0.5, np.float32)
    out = render_lut(lut, img)
    assert np.allclose(out[..., 0], 0.5, atol=1e-5)

def test_extreme_params_stay_in_range():
    for params in ({"exposure": 3.0}, {"exposure": -3.0}, {"contrast": 1.0, "saturation": 1.0}):
        out = render_lut(lut_from_params(params), make_fixture("neutral"))
        assert out.min() >= 0.0 and out.max() <= 1.0

def test_to_data_url_is_decodable_and_bounded():
    url = to_data_url(make_fixture("neutral", size=(1080, 1920)))
    assert url.startswith("data:image/jpeg;base64,")
    raw = base64.b64decode(url.split(",", 1)[1])
    assert len(raw) < 1_500_000             # 长边压到 768,不能失控
    Image.open(io.BytesIO(raw)).verify()    # 可解码
```

---

## 4. L2:硬校验(**本方案最关键的一组测试**)

硬校验是「防止 AI 把照片修坏」的最后一道闸门。它必须被证明**真的拦得住**。

```python
def test_r1_rejects_highlight_clipping_increase():
    """喂一个必然造成高光溢出的提议,断言被拒。"""
    img = make_fixture("highlight_clip")
    s = analyze(img)
    bad = {"exposure": 0.9, "gain": [1.3, 1.3, 1.3]}
    ok, reasons = check_hard_rules(s, merge({}, bad), s, limits_for(s))
    assert not ok
    assert any("高光" in r for r in reasons)

def test_r3_rejects_skin_shift():
    img = make_fixture("skin_tone")
    s = analyze(img)
    bad = {"temp": 900, "saturation": 0.5}
    ok, reasons = check_hard_rules(s, merge({}, bad), s, limits_for(s))
    assert not ok
    assert any("肤色" in r for r in reasons)

def test_r4_uses_baseline_not_previous_round():
    """R4(饱和度上限)必须对比最初基线,否则可以逐轮小幅增加绕过。"""
    base = analyze(make_fixture("neutral"))
    # 上一轮已经被推高到接近上限
    prev = replace(base, saturation_mean=base.saturation_mean * 1.55)
    bad = {"saturation": 0.1}          # 相对 prev 只涨一点,但相对 base 已超 1.6×
    ok, reasons = check_hard_rules(prev, merge({}, bad), base, limits_for(base))
    assert not ok, "R4 逐轮累加被绕过"

def test_r5_limits_single_round_exposure():
    s = analyze(make_fixture("under_exposed"))
    ok, reasons = check_hard_rules(s, {"exposure": 1.6}, s, limits_for(s))
    assert not ok

def test_r7_tightens_limits_on_noisy_photo():
    noisy = analyze(make_fixture("noisy"))
    quiet = analyze(make_fixture("neutral"))
    assert limits_for(noisy)["max_contrast_delta"] < limits_for(quiet)["max_contrast_delta"]

def test_good_proposal_passes():
    """反向断言:合理提议不能被误拦,否则功能不可用。"""
    img = make_fixture("under_exposed")
    s = analyze(img)
    ok, reasons = check_hard_rules(s, {"exposure": 0.35, "contrast": 0.2}, s, limits_for(s))
    assert ok, reasons

@pytest.mark.parametrize("code", [i for i in ALL_ISSUE_CODES])
def test_every_rule_has_a_triggering_case(code):
    """每个 Issue/规则都要有能触发它的测试,防止规则写了却没生效。"""
```

---

## 5. L3:`auto_grade` 编排

### 5.1 桩策略

沿用现有 `CHROMA_FAKE_LLM` 的思路,新增 `CHROMA_FAKE_GRADE`,取值:

| 值 | 行为 |
|---|---|
| `conservative` | 提议极小修正(只动曝光) |
| `aggressive` | 提议必然被硬校验拒绝的修正(测拒绝路径) |
| `empty` | 不调工具(测「模型放弃」路径) |
| `always_ok` | 提议温和修正,永远通过 |

测试里更常用的是**注入桩函数**而非环境变量(与 `run_agent(extract_fn, ...)` 的既有风格一致):

```python
def stub_client(proposals: list[dict], review="复核意见"):
    """返回一个假 client,按顺序吐 proposals;用完则返回空 tool_calls。"""
```

### 5.2 断言

```python
def test_produces_single_lut():
    r = auto_grade(img, {}, None, stub_client([{"exposure": 0.3}]))
    lut = lut_from_params(r.params)              # 必须是**一个**参数集
    assert lut.shape == (33, 33, 33, 3)

def test_output_passes_lut_params_validation():
    """产出必须能被 LutParamsModel 接受,否则 API 层会 500。"""
    r = auto_grade(img, {}, None, stub_client([{"exposure": 0.3}]))
    LutParamsModel(**r.params)                   # 不抛异常

def test_incremental_keeps_user_adjustments():
    """增量语义的核心断言:用户手调必须被保留并叠加,不能被重置。"""
    base = {"temp": 300, "saturation": -0.2}
    r = auto_grade(img, base, None, stub_client([{"exposure": 0.3}]))
    assert r.params["temp"] == 300
    assert r.params["saturation"] == -0.2
    assert r.params["exposure"] == pytest.approx(0.3, abs=0.01)

def test_two_runs_accumulate():
    """反复点 = 修正叠加(特性)。第二次的基准是第一次的结果。"""
    r1 = auto_grade(img, {}, None, stub_client([{"exposure": 0.3}]))
    r2 = auto_grade(img, r1.params, None, stub_client([{"exposure": 0.2}]))
    assert r2.params["exposure"] == pytest.approx(0.5, abs=0.02)

def test_no_proposal_returns_base_unchanged():
    r = auto_grade(img, {"temp": 100}, None, stub_client([]))
    assert r.params["temp"] == 100
    assert r.steps == []

def test_rejected_proposal_is_recorded_not_applied():
    r = auto_grade(img, {}, None, stub_client([{"exposure": 2.5}]))   # 超 R5
    assert any(not s.applied and s.rejections for s in r.steps)
    assert r.params.get("exposure", 0.0) != pytest.approx(2.5)

def test_exhausted_rounds_falls_back_to_conservative_and_marks_degraded():
    r = auto_grade(img, {}, None, stub_client([{"exposure": 2.5}] * 5), max_rounds=2)
    assert r.degraded is True
    # 保守解:只做曝光/白平衡,且幅度受限
    assert abs(r.params.get("exposure", 0.0)) <= 0.6
    assert r.params.get("saturation", 0.0) == 0.0

def test_style_cannot_bypass_hard_rules():
    """风格阶段必须再过一次硬校验 —— 这是最容易被忽略的后门。"""
    r = auto_grade(img, {}, "日系清透", stub_client(
        proposals=[{"exposure": 0.2}], style={"exposure": 1.5, "saturation": 0.6}))
    assert r.params["exposure"] < 1.0, "风格提议绕过了硬校验"

def test_style_params_reported_separately():
    r = auto_grade(img, {}, "电影青橙", stub_client(
        proposals=[{"exposure": 0.2}], style={"temp": -200}))
    assert r.style_params == {"temp": -200}       # UI 要拿它给用户核对

def test_no_style_means_style_params_none():
    r = auto_grade(img, {}, None, stub_client([{"exposure": 0.2}]))
    assert r.style_params is None

def test_vision_disabled_skips_image_transfer():
    calls = []
    r = auto_grade(img, {}, None, recording_client(calls), use_vision=False)
    assert r.review is None
    assert not any("image_url" in json.dumps(c) for c in calls), "关闭视觉后仍在传图"

def test_converges_early_without_extra_llm_calls():
    """诊断已无问题时不应再调用 LLM 一轮。"""
    neutral = make_fixture("neutral")
    c = counting_client([{"exposure": 0.01}])
    auto_grade(neutral, {}, None, c)
    assert c.call_count <= 1

def test_vision_review_failure_does_not_fail_whole_request():
    """复检是增强能力,它失败不能导致整个自动修图失败。"""
    r = auto_grade(img, {}, None, stub_client([{"exposure": 0.3}], review=RuntimeError("boom")))
    assert r.params["exposure"] == pytest.approx(0.3, abs=0.01)
    assert r.review is None
```

### 5.3 工具 schema 测试

```python
def test_correction_schema_forbids_extra():
    assert build_correction_tool()["function"]["parameters"]["additionalProperties"] is False

def test_correction_schema_ranges_present():
    """增量字段必须带范围约束,否则模型会给 ±5 EV。"""
    p = build_correction_tool()["function"]["parameters"]["properties"]
    assert p["exposure"]["anyOf"][0]["minimum"] == -1 and p["exposure"]["anyOf"][0]["maximum"] == 1

def test_style_reuses_extract_schema():
    """风格必须复用 ExtractResult 的字段定义,不得另立一套。"""
    style_fields = set(build_correction_tool()["function"]["parameters"]["properties"])
    extract_fields = set(build_tool_schema()["function"]["parameters"]["properties"])
    assert style_fields & extract_fields, "风格参数与调色参数完全脱节"
```

---

## 6. L4 / L5 / L6

### 6.1 L4:API

```python
def test_missing_base_params_422(auth): ...
def test_image_over_limit_413(auth): ...
def test_undecodable_image_400(auth): ...
def test_requires_auth(): assert client.post("/api/auto/grade").status_code == 401
def test_degraded_returns_200_with_flag(auth, monkeypatch): ...
def test_llm_failure_returns_502(auth, monkeypatch): ...
def test_result_persisted_as_agent_message(auth): ...
def test_image_not_persisted(auth):
    """隐私断言:任何表里都不该出现图片二进制。"""
    ...  # 断言 messages.content / params_json 不含 base64 图片前缀
```

### 6.2 L5:前端纯函数

前端已有零依赖脚本先例(`frontend/scripts/check_parity.mjs`)。**用 Node 内置 `node:test`,不引入 vitest/jest**,保持与现有风格一致:

`frontend/scripts/test_auto_grade.mjs`,`make` 里加 `test-frontend` 目标。

```js
test('buildAutoGradeForm 必带 base_params', () => {
  const fd = buildAutoGradeForm({ file: fakeFile(), params: { temp: 300 } })
  assert.equal(fd.get('base_params'), JSON.stringify({ temp: 300 }))
})

test('空风格不进表单', () => {
  assert.equal(buildAutoGradeForm({ file: f, params: {}, style: '   ' }).get('style'), null)
})

test('diffParams 只列出真正变化的字段', () => {
  assert.deepEqual(diffParams({ temp: 300, contrast: 0 }, { temp: 120, contrast: 0 }),
                   [{ key: 'temp', label: '色温', text: '色温 -180K' }])
})

test('summarizeSteps 把技术字段翻成中文且顺序固定', () => { /* 4 步固定 */ })
```

### 6.3 L6:端到端(Playwright,桩 LLM)

```
上传样张(fixture JPEG)
  → 断言「AI 自动修图」按钮从禁用变可用
  → 填风格描述「日系清透一点」
  → 点击 → 断言进度面板出现且四步齐全
  → 等待完成 → 断言报告面板出现
  → 断言色温滑杆显示值 ≠ 修图前(参数确实被改)
  → 断言「本次调整」摘要非空
  → 点「撤销」→ 断言滑杆恢复原值
  → 断言控制台无 error
```

补充用例:

- **未上传照片时按钮禁用**(合成图状态)
- **关闭视觉复核** → 步骤 4 显示「已关闭视觉复核」
- **桩模型返回 aggressive** → 断言降级警示可见,且 `role="status"` 存在

---

## 7. 真实接口 smoke(不打进 CI)

单独脚本 `backend/scripts/smoke_auto_grade.py`,人工触发:

```
1. 用 fixtures 生成 3 张缺陷图(欠曝 / 偏暖 / 肤色)
2. 对每张跑一次真实 auto_grade
3. 打印:诊断 / 提议 / 硬校验结果 / 复检意见 / token / 耗时
4. 断言最终输出过 LutParamsModel,并落盘 .cube 供人眼查看
```

**只在人工判断时才跑** —— 它会消耗真实配额,且模型输出有抽样波动,不适合做回归断言。它回答的是「这功能到底好不好用」,而不是「代码有没有坏」。

---

## 8. 回归防护

`make check` 必须继续全绿。新增目标:

```makefile
test-frontend:   ## 前端纯函数测试(Node 内置 test runner,零依赖)
	@cd $(FRONTEND) && node --test scripts/

check: test test-frontend test-parity
```

**关键回归风险**:本次改动**不碰 `lut_engine`**,所以两道 parity 校验应当完全不受影响。如果哪天 `make test-parity` 因为自动修图挂了,说明有人把渲染/参数逻辑写进了引擎层 —— 那是架构违规,应改回 `photo/`。

---

## 9. 覆盖率目标与不做的事

| 模块 | 目标 | 理由 |
|---|---|---|
| `photo/stats.py` | 行覆盖 ≥ 90% | 地基,算错全盘错 |
| `photo/quality.py` | **每个阈值常量都被触达** | 阈值没测等于没有阈值 |
| `photo/render.py` | 全分支(含恒等、极端参数、边界采样) | 采样写错会静默偏差 |
| 硬校验 | **7 条规则每条都有拒绝用例 + 1 条通过用例** | 闸门必须被证明有效 |
| `agent/auto.py` | 主路径 + 拒绝 + 降级 + 风格 + 视觉开关 | 分支即风险 |
| 前端纯函数 | 主要函数全覆盖 | 便宜,收益直接 |

**不做**:

- ❌ 对 LLM 输出内容做断言(「诊断里必须含『曝光』二字」)—— 抽样波动会让测试随机红,这是脆弱测试
- ❌ 真实照片的黄金图对比 —— 换成任何一张图就失效;用合成 fixtures 代替
- ❌ 视觉复检的语义正确性 —— 无法自动判定「审美对不对」,交给人工 smoke

---

## 10. 新算子(影调分区与分离色调)的测试

`backend/tests/test_tone_regions.py`,分四组:

### 1. 恒等性 —— 最高优先级

```python
def test_default_params_are_exact_identity():
    """默认参数必须精确恒等:否则会静默改变所有已保存 LUT 的行为。"""
    assert np.abs(generate_lut(lut_params_from_dict({}), 33) - build_grid(33)).max() < 1e-12

@pytest.mark.parametrize("key", ["highlights","shadows","whites","blacks","curve",
                                 "split_shadow_sat","split_highlight_sat"])
def test_neutral_value_of_each_new_param_is_identity(key):
    assert np.abs(generate_lut(lut_params_from_dict({key: 0.0}), 33) - build_grid(33)).max() < 1e-12
```

### 2. 方向正确性(反向断言,防止算子写成空实现)

每个算子都要断言「该动的动了、不该动的没动」:

| 算子 | 断言 |
|---|---|
| `highlights` 负值 | 亮点变暗,**暗点基本不动** |
| `shadows` 正值 | 暗点变亮,**亮点基本不动** |
| `whites` 正值 | 亮部抬起,暗部不动 |
| `blacks` 正值 | **纯黑被抬起**(回归:曾因公式反向,抬黑对纯黑完全无效) |
| `curve` 正值 | 暗部压低 **且** 亮部抬高(回归:曾实现成「整体提亮」) |
| `split_*` | 阴影染色主要作用于暗部;`balance` 越大高光覆盖越广(回归:方向曾反) |
| 全部 | 输出仍在 [0,1] |

### 3. 精度包络(防退化)

`GRADING_RECIPES` 列出 5 套真实调色方案及其实测误差上限,断言不超限:

```python
@pytest.mark.parametrize("name", list(GRADING_RECIPES))
def test_lattice_precision_within_measured_envelope(name):
    params, limit = GRADING_RECIPES[name]
    assert _interp_max_error(params) <= limit, f"{name} 的 33³ 插值误差超出标定上限"
```

**这是放宽滑杆范围时的唯一防线。** 想让某个参数超过 ±1?先跑这组看误差。

另外记录**已知限制**(不是缺陷,是 33³ 的固有代价):

```python
def test_over_stacked_grading_is_the_known_limit():
    """重叠加时误差上升;归因实验表明主因是既有的 contrast/saturation,不是新算子。"""
```

### 4. 顺序契约

```python
def test_existing_op_order_unchanged():
    """原有 5 步算子的相对顺序不能变 —— 改了会让已保存 LUT 结果漂移。"""
    # 手写链 vs apply_encoded_ops,逐算子比对
```

---

## 11. 文档与代码的一致性测试

本项目已经吃过一次「文档与代码不一致」的教训(README 长期写「11 个参数」,实际 `LutParams` 是 12 个)。这类漂移不会让测试变红,但会误导每一个读文档的人。所以对**可从代码推导的事实**加断言:

```python
def test_param_count_in_docs_matches_code():
    """文档里的参数个数必须等于 LutParams 实际字段数。"""
    import re
    from pathlib import Path
    from lut_engine.params import LutParams

    n = len(LutParams.__dataclass_fields__)          # 当前 12
    root = Path(__file__).resolve().parent.parent.parent
    for rel in ("README.md", "docs/specs/architecture.md", "docs/specs/ui-design.md"):
        text = (root / rel).read_text(encoding="utf-8")
        for m in re.finditer(r"(\d+)\s*个(?:风格)?参数", text):
            assert int(m.group(1)) == n, f"{rel} 写 {m.group(1)} 个参数,代码是 {n} 个"

def test_correction_tool_excludes_base_photo_style():
    """base_photo_style 决定 LUT 输入侧,不属于「修一点色」,必须是只读。"""
    props = build_correction_tool()["function"]["parameters"]["properties"]
    assert "base_photo_style" not in props

def test_style_tool_covers_all_style_fields():
    """风格复用 ExtractResult 时,STYLE_FIELDS 必须全部可达。"""
    from agent.schemas import STYLE_FIELDS, build_tool_schema
    props = set(build_tool_schema()["function"]["parameters"]["properties"])
    assert set(STYLE_FIELDS) <= props

def test_documented_thresholds_exist_in_code():
    """技术设计文档里列出的阈值常量,必须在 quality.py 中真实存在。"""
    import re
    from pathlib import Path
    from photo import quality

    root = Path(__file__).resolve().parent.parent.parent
    doc = (root / "docs/specs/technical.md").read_text(encoding="utf-8")
    names = set(re.findall(r"^([A-Z][A-Z0-9_]{3,})\s*=", doc, re.M))
    missing = [n for n in names if not hasattr(quality, n)
               and n not in {"MAX_ANALYZE_SIDE", "CLIP_HIGH", "CLIP_LOW", "DARK_Q", "BRIGHT_Q"}]
    assert not missing, f"文档提到但代码里不存在的常量: {missing}"
```

**为什么值得写这些**:它们的成本很低(纯读文件),但能挡住「改了代码忘了改文档」和「文档写了代码没实现」两个方向的漂移。最后一条尤其有价值 —— 它保证技术设计里的阈值表不是空头承诺。
