# AI 自动修图 · UI 设计

> 配套文档:[架构设计](./architecture.md) · [技术设计](./technical.md) · [测试方案](./test-plan.md)
> 本文档给出线框、交互状态机、微文案与样式规格。所有取值沿用 `frontend/src/App.css` 的既有设计令牌。

## 可交互原型

**[`frontend/prototype/auto-retouch.html`](../../frontend/prototype/auto-retouch.html)** —— 单文件、无构建、双击即开。

它不只是静态稿,而是可验证的原型:

- **对比图是真实 LUT 变换**:内嵌了与后端同数学的引擎,不是贴图
- **右侧数值由渲染结果实时统计得出**,不是写死文案;诊断(偏冷/偏暖、动态范围)也由像素推导
- 顶部可按设计文档的四种状态(初始 / 修图中 / 完成 / 未达标)与三种变体(无风格 / 关视觉复核 / 有被拒项)切换
- 已用 Playwright 验证 14 项:状态切换、真实变换、撤销、降级警示、无障碍属性、窄屏不溢出、控制台无错

> 原型的作用是**把设计风险提前暴露**。本轮它已经抓出两个真实缺陷:① 修图前后色调修反(样张暖冷写反);② `<details>` 展开状态被重渲染重置。这两类问题只看静态稿是发现不了的。

---

## 1. 设计原则

1. **不新增入口。** 自动修图是「生成」页右栏的能力,不是第四个页面。用户已有的心智模型是「左边聊天 / 右边预览调色」,自动修图属于右侧。
2. **可解释优于神奇。** 每个数字都要能回答「为什么这么调」。宁可界面啰嗦,也不给一个说不清来源的结果。
3. **失败要显眼。** `degraded`、复检意见、被拒提议都必须可见 —— 用户需要知道系统**没能**做到什么。
4. **不破坏现有交互。** 自动修图结束后,用户面对的还是那套滑杆和按钮,不需要学习新东西。

---

## 2. 现有设计令牌(必须沿用)

```css
--ink:      #0a0a0c   /* 页面底色 */
--panel:    #16161a   /* 面板 */
--panel2:   #1c1c22   /* 次级面板 */
--line:     #26262e   /* 分隔线 */
--linestrong:#34343e
--text:     #e9e9ec
--muted:    #9a9aa5
--accent:   #e2a35a   /* 主强调色,琥珀 */
```

配套约定(从现有 CSS 提取,新组件必须一致):

| 项 | 值 |
|---|---|
| 字体 | `Nunito, Manrope, -apple-system, sans-serif`;品牌字重 700 + `letter-spacing: .08em` |
| 面板 | `border: 1px solid var(--line)`, `border-radius: 14px`, `background: var(--panel)` |
| 小圆角 | `8px`(标签/芯片)、`10px`(按钮) |
| 按钮 | `padding: 9px 16px`;主按钮 `background: var(--accent); color: #0a0a0c`;次按钮透明底 + `var(--linestrong)` 边框 |
| 正文字号 | `13px`;标签/次要信息 `12px`,`color: var(--muted)` |
| 数字/参数 | 等宽显示(`font-variant-numeric: tabular-nums`),避免拖动时宽度跳动 |
| 面板间距 | `16px`(栅格 gap)、`20px`(面板内边距) |

**新增一个令牌**(现有色板没有警告色):

```css
--warn: #e0b64a;   /* 降级/警告。与 --accent 区分:accent 是「可操作」,warn 是「需注意」 */
```

---

## 3. 页面线框

自动修图区插在右栏**预览之上**、参数面板之下 —— 用户先看到结果(预览),再看到解释(说明),最后微调(滑杆)。这个顺序与修图的心智流程一致。

```
┌─────────────────────────────── 右栏 (.right-col) ───────────────────────────────┐
│                                                                                 │
│  ┌─ .preview-toolbar ─────────────────────────────────────────────────────────┐  │
│  │  展示形式 [滑动对比 ▾]        上传样张                                      │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ .previews (现有,不改动) ─────────────────────────────────────────────────┐  │
│  │  ┌─ .pane ─────────────┐  ┌─ .slider-wrap ────────────────────────────┐   │  │
│  │  │ 原图                │  │ ┌──────────┬──────────┐                    │   │  │
│  │  │                     │  │ │  修图前  │ 修图后   │                    │   │  │
│  │  │  [合成测试图]        │  │ └──────────┴──────────┘                    │   │  │
│  │  └─────────────────────┘  └───────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ .auto-bar (新增) ────────────────────────────────────────────────────────┐  │
│  │  ✨ [ 风格 (可选)              ]  [ AI 自动修图 ]   ☑ 视觉复核            │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ .auto-progress (新增,仅运行中) ─────────────────────────────────────────┐  │
│  │  ✓ 测量照片          中间调偏暗、整体偏暖                                 │  │
│  │  ✓ 修正影调与色彩    曝光 +0.25 EV、对比 +0.45、色温 -450K                │  │
│  │  ◐ 风格化            正在理解「日系清透」…                                │  │
│  │  · 视觉复核                                                              │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ .auto-report (新增,仅完成后) ───────────────────────────────────────────┐  │
│  │  ┌ ⚠ 未能完全达标,已采用保守调整 ─────────────────────────────────────┐  │  │
│  │  └──────────────────────────────────────────────────────────────────────┘  │  │
│  │  本次调整   曝光 +0.25 EV · 对比 +0.45 · 色温 -450K                       │  │
│  │  风格理解   对比 +0.10 · 色温 -100K          ← 让用户核对模型理解          │  │
│  │  ▸ 完整分析过程(3 步)                                                    │  │
│  │  ▸ 有 1 项提议被安全规则拦下                                              │  │
│  │                                                                           │  │
│  │  [ 撤销 ]                                   ← 回到修图前                  │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ .controls (现有,不改动) ────────────────────────────────────────────────┐  │
│  │  色温 ──●────  0K    色调 ──●────  0   曝光 ──●────  0.25 EV              │  │
│  │  …(22 个参数,按 5 组折叠:基础 / 影调 / 色彩 / 分离色调 / 分通道 RGB)        │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌─ .actions (现有) ────────────────────────────────────────────────────────┐  │
│  │  [LUT 名称]  [保存到我的 LUT] [直接下载机内版] [直接下载后期版]            │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**为什么 `auto-bar` 在预览之下而不是之前**:用户的操作顺序是「先上传、看原图」→「再让 AI 修」→「看对比」。把按钮放在原图上方会让人以为要配好参数才能用。

**为什么进度与报告放在预览之下**:它们是**结果的解释**,紧邻结果、在滑杆之上,视线自然向下流动:对比 → 为什么 → 微调。

---

## 4. 组件规格

### 4.1 `.auto-bar`

```jsx
<div className="auto-bar">
  <span className="auto-bar-icon" aria-hidden="true">✦</span>
  <input
    className="auto-style-input"
    value={style}
    onChange={(e) => setStyle(e.target.value)}
    placeholder="风格(可选):日系清透一点"
    maxLength={200}
    disabled={busy}
    aria-label="风格描述"
  />
  <button className="btn-primary auto-go" onClick={run} disabled={busy || !hasPhoto}
          title={hasPhoto ? '' : '请先上传样张'}>
    {busy ? '修图中…' : 'AI 自动修图'}
  </button>
  <label className="auto-vision">
    <input type="checkbox" checked={useVision} onChange={(e) => setUseVision(e.target.checked)} />
    <span>视觉复核</span>
  </label>
</div>
```

| 元素 | 规格 |
|---|---|
| `.auto-bar` | `display:flex; align-items:center; gap:12px; padding:12px 16px; border:1px solid var(--line); border-radius:14px; background:var(--panel)` |
| `.auto-bar-icon` | 16px,`color: var(--accent)`;装饰元素,`aria-hidden` |
| `.auto-style-input` | `flex:1; min-width:0; padding:9px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel2); color:var(--text); font-size:13px`。`:focus` 时 `border-color: var(--accent)`(与现有 `.name-input:focus` 一致) |
| `.auto-go` | 主按钮样式。禁用态沿用现有 `.btn-primary:disabled` |
| `.auto-vision` | `display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); white-space:nowrap; cursor:pointer` |

**「视觉复核」工具提示**(`title` 属性):

> 开启后会把照片与修图结果发送给模型做主观复检,更准但更慢。关闭后只根据客观数据调整。

这是隐私相关的选择,必须写清楚,不能只写「视觉复核」四个字。

**未上传照片时**:`.auto-go` 禁用,`title="请先上传样张"`。
⚠️ **必须区分真实照片与内置合成图**:当前 `usePreview` 默认加载 `makeTestImage()`。自动修图对合成图无意义,因此用一个 `hasRealPhoto` 标记(上传成功后置 true),合成图状态下按钮禁用并提示「请先上传样张」。

### 4.2 `.auto-progress`

```jsx
<ol className="auto-progress" aria-live="polite">
  <li className="auto-step done">
    <span className="auto-step-mark">✓</span>
    <span className="auto-step-title">测量照片</span>
    <span className="auto-step-detail">中间调偏暗、整体偏暖</span>
  </li>
  <li className="auto-step running">
    <span className="auto-step-mark">◐</span>
    <span className="auto-step-title">风格化</span>
    <span className="auto-step-detail">正在理解「日系清透」…</span>
  </li>
  <li className="auto-step pending">
    <span className="auto-step-mark">·</span>
    <span className="auto-step-title">视觉复核</span>
  </li>
</ol>
```

| 状态 | mark | 颜色 |
|---|---|---|
| `pending` | `·` | `--muted`,标题同色 |
| `running` | `◐` | `--accent`,mark 加 `animation: spin 1.2s linear infinite` |
| `done` | `✓` | `--accent`(不用绿色:色板里没有成功色,且 amber 已足够表示完成) |
| `skipped` | `–` | `--muted`,标题加 `text-decoration: line-through` |

- 布局:`display:grid; gap:8px; padding:14px 16px;` 与 `.auto-bar` 同款式面板
- `.auto-step`:`display:grid; grid-template-columns: 16px 96px 1fr; align-items:baseline; gap:10px; font-size:13px`
- `.auto-step-detail`:`color:var(--muted); font-size:12px`
- `aria-live="polite"` 让读屏用户听到进度变化,但不会被打断

**步骤顺序固定为四步**:测量照片 → 修正影调与色彩 → 风格化(无风格时显示 `skipped`) → 视觉复核(关闭时显示 `skipped`)。固定顺序让用户能预期,而不是每次都不同。

### 4.3b 参数分组折叠(22 个参数)

22 个控件平铺会让面板过长,故按**算子语义**分 5 组折叠(与 `transforms.py` 的算子链顺序对应):

| 分组 | 参数 | 默认 |
|---|---|---|
| 基础 | 基准照片风格、色温、色调、曝光(V-Log 时额外显示高光映射) | **展开** |
| 影调 | 对比度、高光、阴影、白场、黑场、S 曲线 | **展开** |
| 色彩 | 饱和度、自然饱和、色相 | 折叠 |
| 分离色调 | 阴影色相/强度、高光色相/强度、平衡 | 折叠 |
| 分通道(RGB) | 暗部 / 中间调 / 亮部 × R/G/B(9 个控件) | 折叠 |

```jsx
<section className="param-group">
  <button type="button" className="param-group-head"
          aria-expanded={open} onClick={toggle}>
    <span className="param-group-arrow">{open ? '▾' : '▸'}</span>
    <span className="param-group-label">影调</span>
    {!open && <span className="param-group-hint">3 项已调整</span>}
  </button>
  {open && <div className="controls">{/* 滑杆 */}</div>}
</section>
```

**折叠时必须显示「N 项已调整」。** 参数被藏进折叠区后,用户会找不到自己调过什么 ——
这个提示是折叠方案的**必要配套**,不是装饰。它也是「哪些组该展开」的自然提示。

其他规格与现有 `.controls` 一致:面板 `border:1px solid var(--line); border-radius:14px`,
头部 `padding: 11px 20px`,箭头 `color: var(--muted)`。
`aria-expanded` 保证读屏用户知道展开状态;`focus-visible` 提供键盘焦点环。

**必须用 `auto-fit + minmax` 而不是固定列数。** 滑杆栅格写成 `repeat(3, 1fr)` 时,
容器一旦变窄,每个轨道会被压到接近 0 宽 —— 实测在原型上复现过「滑杆完全不可见、文字重叠」。

```css
.controls {
  display: grid;
  /* ✅ 容器不够宽时自动降列 */
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  /* ❌ grid-template-columns: repeat(3, 1fr); 固定列数会压扁滑杆 */
}
```

`220px` 是「标签 52 + 滑杆 + 数值 64 + 两处 gap」仍可用的下限。
实测各视口下的滑杆宽度:1720px→133~179px、1200px→129px、1000px→129px,均无横向溢出。

**另一个易踩点:基础组是 `.param-groups` 的直接子元素**(它没有折叠外壳),
所以「去掉组内滑杆区自身边框」的规则必须同时覆盖两种情况:

```css
.param-group > .controls,
.param-groups > .controls { /* 后者覆盖基础组 */ }
```

### 4.4 `.auto-report`

```jsx
<section className="auto-report">
  {degraded && (
    <div className="auto-warn" role="status">
      ⚠ 未能完全达标,已采用保守调整(仅修正曝光与白平衡)
    </div>
  )}

  <dl className="auto-summary">
    <dt>本次调整</dt>
    <dd>{/* diffParams(before, params) 渲染为 chip 列表 */}</dd>
    {styleParams && (<><dt>风格理解</dt><dd>{/* chips */}</dd></>)}
  </dl>

  <details className="auto-details">
    <summary>完整分析过程({steps.length} 步)</summary>
    {/* 每步:轮次 / 诊断原话 / 提议数值 / 应用后关键指标 */}
  </details>

  {rejected.length > 0 && (
    <details className="auto-details auto-rejected">
      <summary>有 {rejected.length} 项提议被安全规则拦下</summary>
      <ul>{rejected.map((r) => <li key={r}>{r}</li>)}</ul>
    </details>
  )}

  {review && (
    <div className="auto-review">
      <span className="auto-review-label">视觉复核</span>
      <p>{review}</p>
    </div>
  )}

  <div className="auto-report-actions">
    <button className="btn" onClick={undo}>撤销</button>
  </div>
</section>
```

**调整摘要用 chip 而非文字段落。** 复用现有 `.chip` 样式(`padding:7px 14px; border-radius:999px; border:1px solid var(--linestrong)`)。每个 chip 形如 `曝光 +0.25 EV`、`色温 -450K`,变化方向用**符号**表示而非颜色(色板里没有红/绿语义色;且红绿色盲用户需要符号)。

**「风格理解」必须单独一行。** 这是本功能最可能出错的环节(模型把「日系清透」理解成「大幅提亮」),必须让用户一眼核对。

**被拒项默认折叠。** 它是解释性信息不是错误;但摘要行必须显示数量,让用户知道「有东西被拦了」。

**复检意见独立成块**,因为它来自另一个模型调用、性质是主观判断,与确定性数字应视觉区隔(`border-left: 2px solid var(--accent); padding-left: 12px`)。

### 4.4 `degraded` 警示条

```css
.auto-warn {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 10px 12px; margin-bottom: 12px;
  border: 1px solid var(--warn);
  border-radius: 10px;
  background: rgba(224, 182, 74, 0.08);
  color: var(--warn);
  font-size: 13px;
}
```

`role="status"` 让读屏用户获知。**不使用 `role="alert"`** —— 它不是错误,不该打断。

---

## 5. 交互状态机

```
        ┌──────────────────────────────────────────────┐
        │  未上传真实照片 → 按钮禁用(title 提示)          │
        └──────────────────────────────────────────────┘
                              │ 上传样张
                              ▼
  idle ──点击「AI 自动修图」──→ running ──成功──→ done
   ▲                              │                │
   │                              │ 502/网络失败    │ 撤销
   │                              ▼                ▼
   └────────── 重试 ←─────────── error ────────→ idle(恢复快照)
```

| 状态 | UI 表现 |
|---|---|
| `idle` | 按钮可点;风格输入可编辑;无进度/报告面板 |
| `running` | 按钮文案 → 「修图中…」且禁用;风格输入禁用;`.auto-progress` 显示;滑杆**保持可交互**(用户等待时能看当前效果) |
| `done` | `.auto-progress` 收起(或保留为已完成的静态列表);`.auto-report` 出现;滑杆反映新参数;`cubeText` 置空 |
| `error` | 显示 `detail` 文案 + 「重试」按钮;参数**不变**(不能半途污染) |

**关键交互约定**

1. **请求前保存快照。** `runAutoGrade()` 第一步执行 `setUndoSnapshot(params)`,保证任何路径都能撤销。
2. **参数一变,cube 文本失效。** 与现有 `updateParam` 的既有逻辑一致:`setCubeText(null)`,下载时回退前端本地重算。
3. **滑杆在 `running` 期间不禁用。** 用户等待 5~10 秒时若能预览当前效果,感知等待时间会更短。请求返回后以服务端结果覆盖。
4. **撤销后不恢复 `cubeText`**:那份服务端文本对应的是修图后的参数,撤销后已失效。

---

## 6. 微文案

所有面向用户的文案**不用技术词汇**,`evidence` 与 `rejections` 已由后端生成为中文,前端直接展示。

| 位置 | 文案 |
|---|---|
| 按钮(空闲) | `AI 自动修图` |
| 按钮(运行) | `修图中…` |
| 风格占位符 | `风格(可选):日系清透一点` |
| 视觉复核提示 | `开启后会把照片与修图结果发送给模型做主观复检,更准但更慢。关闭后只根据客观数据调整。` |
| 未上传提示 | `请先上传样张` |
| 步骤 1 | `测量照片` |
| 步骤 2 | `修正影调与色彩` |
| 步骤 3 | `风格化` / 跳过时 `未指定风格` |
| 步骤 4 | `视觉复核` / 跳过时 `已关闭视觉复核` |
| 运行中细节 | `正在理解「{style}」…` |
| 降级警示 | `未能完全达标,已采用保守调整(仅修正曝光与白平衡)` |
| 报告标题 | `本次调整` / `风格理解` |
| 折叠项 | `完整分析过程({n} 步)` / `有 {n} 项提议被安全规则拦下` |
| 复检标签 | `视觉复核` |
| 错误兜底 | `分析服务暂时不可用,请稍后重试` |

**措辞原则**

- 说「保守调整」而不是「降级」—— 用户不需要知道内部术语,但需要知道系统做了更小心的选择。
- 说「被安全规则拦下」而不是「校验失败」—— 前者让用户理解这是在保护照片质量。
- 复检意见**原样展示**模型输出,不加「AI 认为」之类前缀(面板已有「视觉复核」标签)。

---

## 7. 无障碍

| 项 | 措施 |
|---|---|
| 进度播报 | `.auto-progress` 用 `aria-live="polite"`;降级提示用 `role="status"` |
| 按钮状态 | 禁用时提供 `title` 说明原因(不能只靠视觉变灰) |
| 键盘 | 风格输入 `Enter` 直接触发修图(与聊天框一致);`Tab` 顺序:风格输入 → 修图按钮 → 视觉复核 |
| 焦点管理 | 完成后把焦点移到 `.auto-report`(加 `tabIndex={-1}`),读屏用户不会丢失位置 |
| 对比度 | 实测(相对 `--panel` `#16161a`):`--muted` 6.48:1、`--accent` 8.27:1、新增 `--warn` 9.42:1,均满足 WCAG AA 正文(≥4.5:1)。**新增任何颜色都必须实测对比度**,不要凭感觉挑 |
| 不依赖颜色 | 参数变化用 `+/-` 符号;步骤状态用符号(✓ ◐ · –)而非仅颜色 |

---

## 8. 响应式

现有布局是两栏 `.gen-layout`(`chat-panel` + `right-col`)。

| 断点 | 行为 |
|---|---|
| `> 1200px` | 现状:两栏并排 |
| `900–1200px` | `.auto-bar` 允许换行(`flex-wrap: wrap`),风格输入占满一行 |
| `< 900px` | 沿用现有单列堆叠;`.auto-progress` 的 `grid-template-columns` 由 `16px 96px 1fr` 改为 `16px 1fr`,细节另起一行 |

---

## 9. 样式清单(新增,可直接落地)

```css
/* 新增令牌 */
:root { --warn: #e0b64a; }

.auto-bar { /* 见 §4.1 */ }
.auto-style-input { }
.auto-go { }
.auto-vision { }

.auto-progress { }
.auto-step { }
.auto-step-mark { }
.auto-step-title { }
.auto-step-detail { }
.auto-step.running .auto-step-mark { animation: auto-spin 1.2s linear infinite; }
@keyframes auto-spin { to { transform: rotate(360deg); } }

.auto-report { }
.auto-warn { }
.auto-summary { display:grid; grid-template-columns: 64px 1fr; gap:6px 12px; font-size:13px; }
.auto-summary dt { color: var(--muted); }
.auto-summary dd { margin:0; display:flex; flex-wrap:wrap; gap:6px; }

.auto-details { font-size:13px; }
.auto-details summary { cursor:pointer; color: var(--muted); padding:6px 0; }
.auto-details summary:hover { color: var(--text); }

.auto-review { border-left: 2px solid var(--accent); padding-left: 12px; font-size:13px; }
.auto-review-label { display:block; color: var(--muted); font-size:12px; margin-bottom:4px; }

.auto-report-actions { display:flex; justify-content:flex-end; gap:8px; }
```

所有面板统一 `border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: 14px 16px;`,与 `.controls` / `.pane` 保持一致。

---

## 10. 不做的事(明确排除)

| 不做 | 原因 |
|---|---|
| 独立的「自动修图」页面 / 第四个 tab | 增加导航负担,且它天然属于生成页右栏 |
| 修图历史时间线 | 与「一键撤销」重复;会话已有消息历史 |
| 实时(边拖滑杆边自动修) | 成本与延迟不可接受,且用户拖滑杆时不应被 AI 覆盖 |
| 批量多图 | 一张 LUT 服务一张照片的优化目标;批量的语义(取交集?)未定义 |
| 把复检意见做成对话 | 会与左侧聊天职责重叠,用户分不清「该在哪说话」 |
