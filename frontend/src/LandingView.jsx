import { useEffect, useRef, useState } from 'react'
import ThemePicker from './components/ThemePicker.jsx'
import './Landing.css'

// 公开样张使用产品引擎渲染；示例参数也可在创作页中调整。
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

// 案例为固定配方，不在落地页调用模型。摘要与渲染使用同一个对象。
const CASE_LOOK = {
  temp: 180, contrast: 0.1, highlights: -0.22, shadows: 0.14,
  vibrance: 0.1, saturation: -0.12,
  split_shadow_hue: 205, split_shadow_sat: 0.06,
  split_highlight_hue: 38, split_highlight_sat: 0.1, split_balance: 0.45,
}
const CASE_SUMMARY = [
  ['冷暖偏移', CASE_LOOK.temp, 0], ['高光', CASE_LOOK.highlights, 2],
  ['阴影', CASE_LOOK.shadows, 2], ['饱和度', CASE_LOOK.saturation, 2],
]

// 渲染走的降采样宽度:样张显示区最宽约 640px,CSS 像素 2x 也够用,
// 再大只是徒增 CPU 与内存(getImageData 会产出 w*h*4 的 Uint8ClampedArray)。
const GRADE_WIDTH = 1280

const STEPS = [
  {
    no: '01',
    title: '选照片',
    body: '上传照片、确认拍摄输入，让预览有可靠的起点。',
  },
  {
    no: '02',
    title: '定风格',
    body: '描述你的想法，优化照片，或从喜欢的参考色彩出发。',
  },
  {
    no: '03',
    title: '调效果',
    body: '放大查看，边看边微调；参数说明帮助你理解每次变化。',
  },
  {
    no: '04',
    title: '保存作品',
    body: '保存可复用的 LUT，或把当前效果导出为一张照片。',
  },
]

const FAQ = [
  {
    q: '输出的 .cube 文件支持哪些软件？',
    a: '后期版为 33 点 .cube LUT，供支持该格式的色彩处理工具导入。请按所用软件的说明选择输入色彩空间，并与制作 LUT 时的输入基准一致。',
  },
  {
    q: '我的松下相机支持 Real-Time LUT 吗？',
    a: '是否支持机内应用、可用的 Photo Style 和导入方式由机型与固件决定。创作页的「输入与相机使用引导」提供导入参考；使用前请核对对应相机的官方说明书。',
  },
  {
    q: '需要登录才能使用吗？',
    a: '创作与管理需要登录。登录后可以创建调色项目、保存自己的 LUT、管理版本，并继续之前的调色。',
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
        if (!alive) return

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
  const [imageFailed, setImageFailed] = useState(false)
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
    if (!gradedSrc || imageFailed) return
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
      <img className="landing-ba-img" src={src} alt="原图" draggable="false" onError={() => setImageFailed(true)} />
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
        disabled={!gradedSrc || imageFailed}
        aria-label="拖动对比 LUT 前后效果"
        onChange={(e) => setAt(Number(e.target.value))}
      />

      <span className="landing-ba-tag landing-ba-tag-before">{beforeLabel}</span>
      <span className="landing-ba-tag landing-ba-tag-after">{gradedSrc ? afterLabel : '效果未就绪'}</span>
      {imageFailed && <div className="landing-image-error" role="status"><strong>示例照片暂未加载</strong><span>你仍可以进入创作，使用自己的照片。</span></div>}
    </div>
  )
}

/**
 * 未登录访客先看到落地页，创作入口进入认证后保留目标页面。
 * 所有文案只陈述产品真实能力,不含编造的用户数/评分/性能承诺。
 */
export default function LandingView({ onEnter }) {
  const gradedHero = useGradedSample(HERO_PHOTO, HERO_LOOK)
  const gradedPreview = useGradedSample(PREVIEW_PHOTO, CASE_LOOK)

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
            <button className="btn btn-ghost" onClick={onEnter}>进入创作</button>
          </div>
        </div>
      </nav>

      <main className="landing-main">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">你的照片，你的色彩</p>
            <h1 id="landing-title">
              从一张照片，<br />
              创造自己的<span className="landing-accent">影调</span>。
            </h1>
            <p className="landing-lede">
              用语言描述想要的色彩，跟着画面一步步调整。
              把喜欢的效果保存成可复用的 LUT，或直接导出调整后的照片。
            </p>
            <div className="landing-hero-actions">
              <button className="btn btn-primary landing-btn-lg" onClick={onEnter}>
                开始创作
              </button>
              <a className="landing-textlink" href="#how-it-works">了解创作流程</a>
            </div>
            <p className="landing-hero-meta">AI 帮你起步，参数与曲线把细节留在你手中。</p>
          </div>
          <figure className="landing-hero-visual">
            <BeforeAfter
              src={HERO_PHOTO}
              gradedSrc={gradedHero}
              beforeLabel="原图"
              afterLabel="青橙风格 · LUT 后"
            />
            <figcaption><span>青橙风格 · 真实 LUT 预览</span><span>拖动分界线查看变化</span></figcaption>
          </figure>
        </section>

        <section id="how-it-works" className="landing-band" aria-labelledby="landing-process-title">
          <div className="landing-wrap">
            <div className="landing-head">
              <p className="landing-eyebrow">创作流程</p>
              <h2 id="landing-process-title">四步，把想法变成作品</h2>
            </div>
            <div className="landing-grid-steps">
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
            <p className="landing-eyebrow">一次创作，从想法到画面</p>
            <h2 id="landing-features-title">把想要的感觉，调成看得见的色彩</h2>
            <p className="landing-sub">先表达方向，再比较变化。每一项调整都可以理解、微调和撤销。</p>
          </div>
          <article className="landing-case">
            <div className="landing-case-copy">
              <span className="landing-demo-label">公开样张 · 预设创作示例</span>
              <h3>留住林间的暖光</h3>
              <blockquote>“暖一点，色彩收敛一些，保留林间光线和暗部层次。”</blockquote>
              <p>从温和的冷暖偏移开始，压低高光、轻提暗部，再降低饱和度。对比照片，决定是否继续精调。</p>
              <dl className="landing-case-values">{CASE_SUMMARY.map(([label, value, digits]) => <div key={label}>
                <dt>{label}</dt><dd>{value > 0 ? '+' : ''}{value.toFixed(digits)}</dd>
              </div>)}</dl>
              <p className="landing-case-note">示例使用固定配方与产品引擎渲染，未实时调用 AI。创作页中可按你的照片继续调整。</p>
              <button className="btn btn-soft" onClick={onEnter}>用自己的照片开始</button>
            </div>
            <figure className="landing-case-photo">
              <BeforeAfter src={PREVIEW_PHOTO} gradedSrc={gradedPreview} beforeLabel="原图" afterLabel="林间暖调 · 示例效果" />
              <figcaption>拖动或使用方向键，比较同一张照片的变化。</figcaption>
            </figure>
          </article>
          <div className="landing-features">
            <article className="landing-feature">
              <div className="landing-feature-copy">
                <p className="landing-feature-kicker">精细调整</p>
                <h3>把细节，留在你手中</h3>
                <p>基础参数帮你起步，全部参数按组展开。放大后继续调色，参数说明、保护和撤销让每次尝试更从容。</p>
              </div>
              <div className="landing-feature-mock">
                <span className="landing-demo-label">四通道曲线 · 界面示意</span>
                <div className="landing-curve-channels" aria-label="主曲线和 RGB 通道曲线示意">
                  {['主曲线', 'R', 'G', 'B'].map(channel => <div className="landing-curve-channel" key={channel}>
                    <span>{channel}</span><svg viewBox="0 0 64 64" aria-hidden="true">
                      <path className="landing-curve-grid" d="M0 16H64M0 32H64M0 48H64M16 0V64M32 0V64M48 0V64" />
                      <path className="landing-curve-line" d="M2 62C20 58 22 22 62 2" />
                    </svg>
                  </div>)}
                </div>
              </div>
            </article>
            <article className="landing-feature">
              <div className="landing-feature-copy">
                <p className="landing-feature-kicker">保存与复用</p>
                <h3>喜欢的色彩，还能再次使用</h3>
                <p>项目保留创作过程，版本记录阶段效果。满意后保存 LUT，或把调整结果导出为照片。</p>
              </div>
              <div className="landing-feature-mock landing-workflow-mock">
                <span className="landing-demo-label">三种保留方式</span>
                <div className="landing-workflow-item"><span>01</span><div><strong>调色项目与版本</strong><p>继续编辑，比较不同方向</p></div></div>
                <div className="landing-workflow-item"><span>02</span><div><strong>我的 LUT</strong><p>保存完整效果或可复用风格</p></div></div>
                <div className="landing-workflow-item"><span>03</span><div><strong>照片与 .cube 导出</strong><p>按输入条件用于照片、相机或后期</p></div></div>
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
            <button className="btn btn-secondary landing-btn-lg" onClick={onEnter}>进入创作</button>
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
