import { useEffect, useRef, useState } from 'react'
import { applyLUTToImageData, defaultParams, generateLUT } from './lib/lutEngine.js'

// 首屏展示的样张与用它演示的影调。参数刻意选成产品 UI 里也能手调出来的值,
// 且全部落在 App.jsx PARAM_GROUPS 的 min/max 区间内 —— 落地页演示的效果
// 与用户在生成页能复现的效果是同一个引擎、同一套取值范围。
const HERO_PHOTO = '/landing/hero.jpg'
const PREVIEW_PHOTO = '/landing/preview.jpg'

const HERO_LOOK = {
  ...defaultParams(),
  temp: 350,
  tint: 60,
  contrast: 0.18,
  highlights: -0.15,
  shadows: 0.15,
  blacks: 0.08,
  vibrance: 0.25,
  saturation: -0.05,
  split_shadow_hue: 205,
  split_shadow_sat: 0.22,
  split_highlight_hue: 38,
  split_highlight_sat: 0.18,
  split_balance: 0.45,
}

// 「实时预览」区块演示的另一档影调。与 HERO_LOOK 明显不同(更冷、对比更强),
// 否则同一个页面里出现两次同款调色,会显得像同一个效果贴了两遍。
const PREVIEW_LOOK = {
  ...defaultParams(),
  temp: -280,
  tint: -40,
  contrast: 0.32,
  highlights: -0.25,
  shadows: -0.1,
  blacks: -0.12,
  whites: 0.1,
  vibrance: 0.35,
  saturation: -0.1,
  split_shadow_hue: 220,
  split_shadow_sat: 0.3,
  split_highlight_hue: 45,
  split_highlight_sat: 0.12,
  split_balance: 0.55,
}

// 渲染走的降采样宽度:样张显示区最宽约 640px,CSS 像素 2x 也够用,
// 再大只是徒增 CPU 与内存(getImageData 会产出 w*h*4 的 Uint8ClampedArray)。
const GRADE_WIDTH = 1280

const PAIN_POINTS = [
  {
    mark: '▸',
    title: '预设不合口味',
    body: '网上的预设包千篇一律，套用在自己的素材上总是差那么一点点意思，且难以针对性调整。',
  },
  {
    mark: '◐',
    title: '手搓曲线门槛高',
    body: '面对复杂的色彩空间、节点和 RGB 曲线，没有系统学习过调色很难精准实现脑海中的画面。',
  },
  {
    mark: '⚠',
    title: '机内 LUT 格式限制',
    body: 'Lumix 机内烧录需要严苛的 33-point .cube 格式，且必须带有特定表头声明，普通 LUT 常常无法载入。',
  },
]

const STEPS = [
  {
    no: '01',
    title: '一句话描述影调',
    body: '像和调色师沟通一样，输入自然语言指令。例如「日系清透，高光带点青色，暗部微灰」。',
  },
  {
    no: '02',
    title: '模型多轮确认参数',
    body: 'CHROMA 会精准理解你的意图，生成具体调色参数。你可以继续通过对话微调，直到完全满意。',
  },
  {
    no: '03',
    title: '导出松下标准 .cube',
    body: '一键下载，直接获得包含松下标准表头的 .cube 文件，插入 SD 卡即可在 Lumix 机身内调用。',
  },
]

const FAQ = [
  {
    q: '输出的 .cube 文件支持哪些软件？',
    a: '只要支持导入 33-point .cube LUT 文件的软件都可以使用，包括且不限于 DaVinci Resolve、Premiere Pro、Final Cut Pro、Photoshop 以及 Lightroom 等。',
  },
  {
    q: '我的松下相机支持 Real-Time LUT 吗？',
    a: '机内烧录（Real-Time LUT）目前支持 S5M2 / S5M2X / G9M2；S5、GH6 等机型仅支持机内监视。下载「机内版」.cube 后存入 SD 卡对应目录即可载入。',
  },
  {
    q: '需要注册账号才能使用吗？',
    a: '基础预览和生成可以直接体验。如需管理你生成的个人 LUT 库、保存调色历史记录，需要创建一个免费账号。',
  },
  {
    q: '生成一个 LUT 需要耗时多久？',
    a: '你发出指令后，模型会在数秒内完成参数计算，并在浏览器内实时渲染预览效果，确认后即可导出。',
  },
]

/** 把样张按 LUT 渲染成 dataURL。产品自己的引擎,不引入任何第三方调色库。 */
function useGradedSample(src, look) {
  const [graded, setGraded] = useState(null)

  useEffect(() => {
    let alive = true
    let canvas
    ;(async () => {
      try {
        const img = new Image()
        img.src = src
        await img.decode()

        const scale = Math.min(1, GRADE_WIDTH / img.naturalWidth)
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, w, h)

        const { data, size } = generateLUT(look, 33)
        const out = applyLUTToImageData(ctx.getImageData(0, 0, w, h), data, size)
        ctx.putImageData(out, 0, 0)

        const url = canvas.toDataURL('image/jpeg', 0.85)
        if (alive) setGraded(url)
        canvas.width = 0
        canvas.height = 0
      } catch {
        // 引擎或解码失败时静默降级:对比区只显示原图,页面其余部分不受影响。
        if (alive) setGraded(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [src, look])

  return graded
}

/** 前后对比:原图铺底,调色图层按 clip-path 揭示,分界线可拖拽。 */
function BeforeAfter({ src, gradedSrc, beforeLabel, afterLabel }) {
  const [at, setAt] = useState(50)
  const barRef = useRef(null)
  const dragging = useRef(false)

  const moveTo = (clientX) => {
    const el = barRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!r.width) return
    const pct = ((clientX - r.left) / r.width) * 100
    setAt(Math.min(100, Math.max(0, pct)))
  }

  const onDown = (e) => {
    dragging.current = true
    moveTo(e.clientX)
  }

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return
      moveTo(e.clientX)
    }
    const onUp = () => {
      dragging.current = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <div
      className="landing-ba"
      ref={barRef}
      style={{ '--ba-at': `${at}%` }}
      onPointerDown={onDown}
    >
      <img className="landing-ba-img" src={src} alt="原图" draggable="false" />
      {gradedSrc && (
        <img
          className="landing-ba-img landing-ba-graded"
          src={gradedSrc}
          alt="应用 LUT 后"
          draggable="false"
        />
      )}
      <span className="landing-ba-divider" aria-hidden="true">
        <span className="landing-ba-knob">◂ ▸</span>
      </span>

      <input
        className="landing-ba-range"
        type="range"
        min="0"
        max="100"
        step="0.1"
        value={at}
        aria-label="拖动对比 LUT 前后效果"
        onChange={(e) => setAt(Number(e.target.value))}
      />

      <span className="landing-ba-tag landing-ba-tag-before">{beforeLabel}</span>
      <span className="landing-ba-tag landing-ba-tag-after">{afterLabel}</span>
    </div>
  )
}

/**
 * 落地页。位于登录门之前:未登录访客先看到它,点 CTA 才进入生成流程。
 * 所有文案只陈述产品真实能力,不含编造的用户数/评分/性能承诺。
 */
export default function LandingView({ onEnter }) {
  const gradedHero = useGradedSample(HERO_PHOTO, HERO_LOOK)
  const gradedPreview = useGradedSample(PREVIEW_PHOTO, PREVIEW_LOOK)

  return (
    <div className="landing">
      <nav className="landing-nav">
        <div className="brand">
          <span className="logo">C</span>
          CHROMA
        </div>
        <div className="landing-nav-links">
          <a href="#features">功能</a>
          <a href="#how-it-works">工作原理</a>
          <a href="#lumix">机内烧录</a>
          <a href="#faq">常见问题</a>
        </div>
        <button className="btn btn-primary" onClick={onEnter}>开始生成</button>
      </nav>

      <main className="landing-main">
        {/* Hero */}
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <h1>
              用你的语言，<br />
              生成你的 <span className="landing-accent">LUT</span>。
            </h1>
            <p className="landing-lede">
              告别繁琐的曲线和节点。只需用自然语言描述你想要的影调（如「日系清透」），CHROMA
              即可直接生成适用于松下 Lumix 相机直出与后期的标准 .cube 文件。
            </p>
            <div className="landing-hero-actions">
              <button className="btn btn-primary landing-btn-lg" onClick={onEnter}>
                开始生成我的 LUT
              </button>
              <a className="landing-textlink" href="#how-it-works">了解工作原理</a>
            </div>
          </div>

          <BeforeAfter
            src={HERO_PHOTO}
            gradedSrc={gradedHero}
            beforeLabel="原图 (V-Log)"
            afterLabel="电影青橙 LUT"
          />
        </section>

        {/* Pain points */}
        <section className="landing-section landing-section-tight">
          <div className="landing-head">
            <h2>从灵感到实用的巨大落差</h2>
            <p className="landing-sub">想要一个特定的影调，但把它真正装进相机里并不容易。</p>
          </div>
          <div className="landing-grid-3">
            {PAIN_POINTS.map((p) => (
              <article className="landing-card" key={p.title}>
                <span className="landing-mark">{p.mark}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="landing-band">
          <div className="landing-wrap">
            <h2 className="landing-h2-center">三步生成，直接可用</h2>
            <div className="landing-grid-3 landing-grid-steps">
              {STEPS.map((s) => (
                <div className="landing-step" key={s.no}>
                  <span className="landing-step-no">{s.no}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="landing-wrap landing-section">
          <div className="landing-feature">
            <div className="landing-feature-mock">
              <p className="landing-bubble landing-bubble-user">我想要一个复古胶片感，稍微偏暖，暗部有点褪色。</p>
              <p className="landing-bubble landing-bubble-bot">
                已为你生成「复古胶片」参数。已应用：色温 +350K，对比度 +0.18，饱和度 -0.05，暗部轻微提亮。
                <br /><br />
                你可以继续微调，或直接保存 .cube。
              </p>
            </div>
            <div className="landing-feature-copy">
              <span className="landing-mark">▸</span>
              <h3>会话式生成</h3>
              <p>
                无需手搓 22 个调色参数。通过简单的对话描述（例如「日系清透」），模型会理解你的意图并设定参数，
                你只需微调确认，即可直接导出标准 .cube 文件。
              </p>
            </div>
          </div>

          <div className="landing-feature">
            <div className="landing-feature-copy">
              <span className="landing-mark">◐</span>
              <h3>实时预览</h3>
              <p>
                采用 WebGL2 3D LUT GPU 叠加技术。上传你的样片，在浏览器中即可实现无延迟的精准色彩渲染。
                支持灵活的滑动对比与独立展示两种模式，在烧录前就确认最终效果。
              </p>
            </div>
            <div className="landing-feature-mock landing-feature-photo">
              <BeforeAfter
                src={PREVIEW_PHOTO}
                gradedSrc={gradedPreview}
                beforeLabel="Before"
                afterLabel="After"
              />
            </div>
          </div>

          <div className="landing-feature">
            <div className="landing-feature-mock">
              <div className="landing-report">
                <div className="landing-report-head">
                  <strong>AI 诊断报告</strong>
                  <span className="landing-badge">分析完成</span>
                </div>
                <ul className="landing-report-list">
                  <li>» 原片曝光正常，高光区域无溢出</li>
                  <li>» 识别环境：室外自然光，色温偏冷</li>
                  <li>» 已应用指令：<em>「再清透一点」</em></li>
                </ul>
                <div className="landing-report-foot">
                  <span className="landing-quiet">↺ 一键撤销</span>
                  <span className="landing-chip">查看完整修改说明</span>
                </div>
              </div>
            </div>
            <div className="landing-feature-copy">
              <span className="landing-mark">✦</span>
              <h3>AI 自动修图</h3>
              <p>
                一键上传照片，AI 自动分析画面结构并产出专属修图 LUT。支持在分析基础上叠加「日系清透一点」等
                自然语言指令。全透明展示诊断依据与详细修改记录，随时支持一键撤销。
              </p>
            </div>
          </div>

          <div className="landing-feature">
            <div className="landing-feature-copy">
              <span className="landing-mark">▾</span>
              <h3>精细调色参数面板</h3>
              <p>
                并非简单的滤镜黑盒。我们开放了 22 个专业级参数，按组逻辑折叠：基础（色温/曝光）、
                影调（对比度/高光/阴影/S 曲线）、色彩（饱和度/自然饱和/色相）、分离色调及分通道调整，
                满足后期深度定制。
              </p>
            </div>
            <div className="landing-feature-mock">
              <div className="landing-params">
                <div className="landing-params-group">
                  <div className="landing-params-head">
                    <strong>基础 (Base)</strong>
                    <span className="landing-quiet">▾</span>
                  </div>
                  <div className="landing-params-row">
                    <div className="landing-params-label">
                      <span>色温 (Temp)</span>
                      <em>+350</em>
                    </div>
                    <div className="landing-params-track"><i style={{ width: '56%' }} /></div>
                  </div>
                  <div className="landing-params-row">
                    <div className="landing-params-label">
                      <span>曝光 (Exposure)</span>
                      <em>0.0</em>
                    </div>
                    <div className="landing-params-track"><i className="landing-params-track-alt" style={{ width: '50%' }} /></div>
                  </div>
                </div>
                <div className="landing-params-group landing-params-collapsed">
                  <div className="landing-params-head">
                    <span className="landing-quiet">影调 (Tone)</span>
                    <span className="landing-quiet">▸</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Lumix in-camera */}
        <section id="lumix" className="landing-band">
          <div className="landing-wrap landing-wrap-narrow">
            <div className="landing-lumix">
              <span className="landing-lumix-mark">◐</span>
              <h2>专为松下机内烧录设计</h2>
              <p className="landing-sub">
                彻底打通后期与前期的壁垒。生成的 LUT 专门针对松下机身（如 S5M2 / G9M2 等）的
                Real-Time LUT 功能进行了深度优化，支持 V-Log 高光映射，让直出也能拥有电影级色彩。
              </p>
              <div className="landing-downloads">
                <div className="landing-download">
                  <span className="landing-mark-sm">▼</span>
                  <strong>下载机内版</strong>
                  <span className="landing-quiet">带特定 Panasonic 表头，机内完美读取</span>
                </div>
                <div className="landing-download">
                  <span className="landing-mark-sm">▸</span>
                  <strong>下载后期版</strong>
                  <span className="landing-quiet">标准通用格式，兼容达芬奇与 PR</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="landing-wrap landing-faq">
          <h2 className="landing-h2-center">常见问题</h2>
          {FAQ.map((item) => (
            <details className="landing-item" key={item.q}>
              <summary>
                {item.q}
                <span className="landing-quiet landing-faq-mark">＋</span>
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>

        {/* Closing CTA */}
        <section id="generate" className="landing-cta">
          <h2>准备好制作你的专属影调了吗？</h2>
          <p className="landing-sub">无需繁琐后期，仅用语言即可塑造直出风格。</p>
          <button className="btn btn-primary landing-btn-lg" onClick={onEnter}>
            开始生成我的第一款 LUT
          </button>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div>
            <div className="landing-footer-brand">CHROMA</div>
            <p className="landing-quiet">A Panasonic Lumix LUT Generator.</p>
          </div>
          <div className="landing-footer-links">
            <a href="#top">回到顶部</a>
            <a href="#faq">常见问题</a>
            <a href="#features">功能</a>
          </div>
        </div>
        <p className="landing-copyright">© CHROMA · 松下 LUT 生成器</p>
      </footer>
    </div>
  )
}
