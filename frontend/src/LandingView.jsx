import { useEffect, useRef, useState } from 'react'
import ThemePicker from './components/ThemePicker.jsx'
import './Landing.css'

// 首屏展示的样张与用它演示的影调。参数刻意选成产品 UI 里也能手调出来的值,
// 且全部落在 App.jsx PARAM_GROUPS 的 min/max 区间内 —— 落地页演示的效果
// 与用户在生成页能复现的效果是同一个引擎、同一套取值范围。
const HERO_PHOTO = '/landing/hero.jpg'
const PREVIEW_PHOTO = '/landing/preview.jpg'

const HERO_LOOK = {
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

const STEPS = [
  {
    no: '01',
    title: '放入自己的照片',
    body: '上传样张并确认拍摄时的输入风格，让后续预览和调整有可靠的起点。',
  },
  {
    no: '02',
    title: '描述并调整影调',
    body: '用语言表达想法，让 AI 提议参数；也可以从参考图出发，或直接手动调色。',
  },
  {
    no: '03',
    title: '查看细节，保存作品',
    body: '放大对比，微调到满意，再保存可复用的 LUT，或导出调整后的照片。',
  },
]

const FAQ = [
  {
    q: '输出的 .cube 文件支持哪些软件？',
    a: '后期版为 33 点 .cube LUT，供支持该格式的色彩处理工具导入。请按所用软件的说明选择输入色彩空间，并与制作 LUT 时的输入基准一致。',
  },
  {
    q: '我的松下相机支持 Real-Time LUT 吗？',
    a: '是否支持机内应用、可用的 Photo Style 和导入方式由机型与固件决定。生成页的「输入与相机使用引导」提供导入参考；使用前请核对对应相机的官方说明书。',
  },
  {
    q: '需要登录才能使用吗？',
    a: '生成与管理需要登录。登录后可以创建调色项目、保存自己的 LUT、管理版本，并继续之前的调色。',
  },
  {
    q: '不理解调色参数，也可以开始吗？',
    a: '可以从一句风格描述或 AI 自动修图开始。参数旁的使用说明会解释调整含义与增减效果；熟悉后再尝试主曲线和 RGB 通道曲线。',
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
        const { applyLUTToImageData, generateLUT } = await import('./lib/lutEngine.js')
        if (!alive) return
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
      <span className="landing-ba-tag landing-ba-tag-after">{gradedSrc ? afterLabel : '效果未就绪'}</span>
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
    <div className="landing" id="top">
      <nav className="landing-nav" aria-label="首页导航">
        <div className="landing-nav-inner">
          <div className="brand">
            <span className="logo">C</span>
            CHROMA
          </div>
          <div className="landing-nav-links">
            <a href="#features">功能</a>
            <a href="#how-it-works">创作流程</a>
            <a href="#lumix">相机与软件</a>
            <a href="#faq">常见问题</a>
          </div>
          <div className="landing-nav-actions">
            <ThemePicker />
            <button className="btn btn-primary" onClick={onEnter}>开始生成</button>
          </div>
        </div>
      </nav>

      <main className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">让影调成为你的表达</p>
            <h1 id="landing-title">
              把你的灵感，<br />
              调成一款 <span className="landing-accent">LUT</span>。
            </h1>
            <p className="landing-lede">
              从一张照片开始，用语言描述想要的色彩，边看细节边微调。
              把喜欢的效果保存成可复用的 LUT，或直接导出调整后的照片。
            </p>
            <div className="landing-hero-actions">
              <button className="btn btn-primary landing-btn-lg" onClick={onEnter}>
                开始制作我的 LUT
              </button>
              <a className="landing-textlink" href="#features">看看可以做什么</a>
            </div>
            <p className="landing-hero-meta">AI 创作 · 手动调色 · Lumix 与后期 .cube</p>
          </div>
          <figure className="landing-hero-visual">
            <BeforeAfter
              src={HERO_PHOTO}
              gradedSrc={gradedHero}
              beforeLabel="原图"
              afterLabel="青橙风格 · LUT 后"
            />
            <figcaption>拖动分界线，查看同一张照片的调色变化。</figcaption>
          </figure>
        </section>

        <section id="how-it-works" className="landing-band" aria-labelledby="landing-process-title">
          <div className="landing-wrap">
            <div className="landing-head">
              <p className="landing-eyebrow">创作流程</p>
              <h2 id="landing-process-title">从照片到影调，循着画面慢慢调整</h2>
            </div>
            <div className="landing-grid-3 landing-grid-steps">
              {STEPS.map((s) => (
                <article className="landing-step" key={s.no}>
                  <span className="landing-step-no">{s.no}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="landing-section" aria-labelledby="landing-features-title">
          <div className="landing-head">
            <p className="landing-eyebrow">创作工具</p>
            <h2 id="landing-features-title">灵感有起点，调整有空间</h2>
            <p className="landing-sub">让 AI 帮你起步，也把每一处细节留在自己手中。</p>
          </div>
          <div className="landing-features">
            <article className="landing-feature">
              <div className="landing-feature-copy">
                <p className="landing-feature-kicker">AI 创作与自动修图</p>
                <h3>说出想法，看见具体的调整</h3>
                <p>
                  用「偏暖的复古胶片感」表达想法，再通过对话修改。
                  也可以让 AI 先分析样张、提议调整参数，查看修改说明后继续微调或撤销。
                </p>
              </div>
              <div className="landing-feature-mock">
                <span className="landing-demo-label">对话示例</span>
                <p className="landing-bubble landing-bubble-user">我想要偏暖的复古胶片感，暗部轻轻提亮。</p>
                <div className="landing-bubble landing-bubble-bot">
                  <strong>把想法变成可调整的参数</strong>
                  <p>尝试增加冷暖偏移、降低饱和度，并提亮暗部。确认后可以在样张上查看变化。</p>
                  <span>查看说明 · 继续微调 · 随时撤销</span>
                </div>
              </div>
            </article>

            <article className="landing-feature">
              <div className="landing-feature-copy">
                <p className="landing-feature-kicker">实时预览与细节查看</p>
                <h3>一边看画面，一边调色</h3>
                <p>
                  滑动对比或并排查看原图与调整结果。放大后可以继续调整参数和曲线，
                  检查高光、肤色与暗部细节，多张样张帮助判断风格是否合适。
                </p>
              </div>
              <div className="landing-feature-mock landing-feature-photo">
                <BeforeAfter
                  src={PREVIEW_PHOTO}
                  gradedSrc={gradedPreview}
                  beforeLabel="原图"
                  afterLabel="LUT 后"
                />
              </div>
            </article>

            <article className="landing-feature">
              <div className="landing-feature-copy">
                <p className="landing-feature-kicker">参数与四通道曲线</p>
                <h3>从简单微调，到自己的色彩细节</h3>
                <p>
                  曝光、影调、全局与局部色彩按组展开，参数说明帮助理解增减的效果。
                  主曲线和 R、G、B 曲线独立展示；直接输入数值、保护参数和撤销记录让精调更从容。
                </p>
              </div>
              <div className="landing-feature-mock">
                <span className="landing-demo-label">调色面板示意</span>
                <div className="landing-params">
                  <div className="landing-params-group">
                    <div className="landing-params-head"><strong>单张校正</strong><span className="landing-quiet">参数说明 ?</span></div>
                    <div className="landing-params-row">
                      <div className="landing-params-label"><span>冷暖偏移</span><em>+350</em></div>
                      <div className="landing-params-track"><i style={{ width: '56%' }} /></div>
                    </div>
                    <div className="landing-params-row">
                      <div className="landing-params-label"><span>曝光</span><em>0.00 EV</em></div>
                      <div className="landing-params-track"><i style={{ width: '50%' }} /></div>
                    </div>
                  </div>
                  <div className="landing-curve-channels" aria-label="主曲线和 RGB 通道曲线示意">
                    {['主曲线', 'R', 'G', 'B'].map((channel) => (
                      <div className="landing-curve-channel" key={channel}>
                        <span>{channel}</span>
                        <svg viewBox="0 0 64 64" aria-hidden="true">
                          <path className="landing-curve-grid" d="M0 16H64M0 32H64M0 48H64M16 0V64M32 0V64M48 0V64" />
                          <path className="landing-curve-line" d="M2 62C20 58 22 22 62 2" />
                        </svg>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </article>

            <article className="landing-feature">
              <div className="landing-feature-copy">
                <p className="landing-feature-kicker">参考、试套与导出</p>
                <h3>用喜欢的作品启发下一次创作</h3>
                <p>
                  从参考图的色彩出发，或导入已有 .cube 在样张上试套。
                  保存作品与版本，导出供相机或后期使用的 LUT，也能把当前效果导出为照片。
                </p>
              </div>
              <div className="landing-feature-mock landing-workflow-mock">
                <span className="landing-demo-label">调色项目能力</span>
                <div className="landing-workflow-item"><span>01</span><div><strong>参考图风格匹配</strong><p>从参考色彩开始，继续调整自己的样张</p></div></div>
                <div className="landing-workflow-item"><span>02</span><div><strong>外部 .cube 导入与试套</strong><p>在真实照片上比较已有 LUT 的效果</p></div></div>
                <div className="landing-workflow-item"><span>03</span><div><strong>保存 LUT 与导出照片</strong><p>保留创作版本，让喜欢的效果再次使用</p></div></div>
              </div>
            </article>
          </div>
        </section>

        <section id="lumix" className="landing-band" aria-labelledby="landing-lumix-title">
          <div className="landing-wrap landing-lumix">
            <div className="landing-lumix-copy">
              <p className="landing-eyebrow">相机与后期</p>
              <h2 id="landing-lumix-title">同一款影调，找到合适的使用方式</h2>
              <p className="landing-sub">
                为 Lumix 制作机内版，或导出后期使用的标准 .cube。
                制作与使用时保持输入基准一致，并按相机型号、固件和软件说明核对设置。
              </p>
              <a className="landing-textlink" href="#faq">了解输入与兼容性</a>
            </div>
            <div className="landing-downloads">
              <div className="landing-download"><strong>机内版 LUT</strong><p>包含 Panasonic 标记；按相机支持的格式导入，并匹配基础 Photo Style。</p></div>
              <div className="landing-download"><strong>后期版 LUT</strong><p>标准 33 点 .cube；在软件中匹配输入信号，避免重复的色彩转换。</p></div>
            </div>
          </div>
        </section>

        <section id="faq" className="landing-faq" aria-labelledby="landing-faq-title">
          <div className="landing-head"><h2 id="landing-faq-title">开始前，你可能想知道</h2></div>
          {FAQ.map((item) => (
            <details className="landing-item" key={item.q}>
              <summary>{item.q}<span className="landing-quiet landing-faq-mark" aria-hidden="true">＋</span></summary>
              <p>{item.a}</p>
            </details>
          ))}
        </section>

        <section id="generate" className="landing-cta" aria-labelledby="landing-cta-title">
          <div className="landing-cta-inner">
            <div><h2 id="landing-cta-title">从一张照片，开始你的下一款影调</h2><p className="landing-sub">把想法交给画面，把细节留给自己。</p></div>
            <button className="btn btn-primary landing-btn-lg" onClick={onEnter}>开始生成我的第一款 LUT</button>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div><div className="landing-footer-brand">CHROMA</div><p className="landing-quiet">用照片与语言，创造自己的影调。</p></div>
          <div className="landing-footer-links"><a href="#top">回到顶部</a><a href="#faq">常见问题</a><a href="#features">功能</a></div>
        </div>
        <p className="landing-copyright">© CHROMA · Lumix LUT 创作工作台</p>
      </footer>
    </div>
  )
}
