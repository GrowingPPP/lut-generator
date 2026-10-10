import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { normalizeParams } from '../lib/lutEngine.js'
import { parameterSignature } from '../lib/workspaceFlow.js'
import { curvePoints, diagnosticDimensions, hueWeight, measureDiagnostics } from '../lib/diagnostics.js'
import { preloadExternalLut, resolveExternalLut } from '../lib/importedLuts.js'
import './DiagnosticsPanel.css'

const CHANNELS = [
  { key: 'luma', label: '亮度', color: '#efbb7a' },
  { key: 'r', label: '红通道 R', color: '#d9857e' },
  { key: 'g', label: '绿通道 G', color: '#82b895' },
  { key: 'b', label: '蓝通道 B', color: '#83aee0' },
]
const percent = (value) => `${value.toFixed(2)}%`
const deltaText = (value) => `${value > 0 ? '+' : ''}${value.toFixed(2)} 个百分点`

function histogramPath(bins, maximum) {
  return bins.map((count, index) => `${index ? 'L' : 'M'} ${(index / (bins.length - 1) * 300).toFixed(2)} ${(88 - count / maximum * 80).toFixed(2)}`).join(' ')
}

function Histogram({ channel, baseline, current }) {
  const maximum = Math.max(1, ...baseline, ...current)
  const path = histogramPath(current, maximum)
  return (
    <figure className="diagnostics-histogram" style={{ '--diagnostics-channel': channel.color }}>
      <figcaption>{channel.label}</figcaption>
      <svg viewBox="0 0 300 106" role="img" aria-label={`${channel.label}直方图，实线当前效果，虚线技术基线`}>
        <path className="diagnostics-grid" d="M0 8H300 M0 48H300 M0 88H300 M150 8V88" />
        <path className="diagnostics-histogram-fill" d={`${path} L300 88 L0 88 Z`} />
        <path className="diagnostics-histogram-current" d={path} />
        <path className="diagnostics-histogram-baseline" d={histogramPath(baseline, maximum)} />
        <text x="0" y="103">0</text><text x="150" y="103" textAnchor="middle">0.5</text><text x="300" y="103" textAnchor="end">1</text>
      </svg>
    </figure>
  )
}

function RiskPreview({ result, enabled }) {
  const currentRef = useRef(null)
  const overlayRef = useRef(null)
  useEffect(() => {
    for (const [reference, pixels] of [[currentRef, result.current_pixels], [overlayRef, result.overlay_pixels]]) {
      const canvas = reference.current
      canvas.width = result.width; canvas.height = result.height
      canvas.getContext('2d').putImageData(new ImageData(pixels, result.width, result.height), 0, 0)
    }
  }, [result])
  return (
    <div className="diagnostics-risk-preview" style={{ aspectRatio: `${result.width} / ${result.height}`, maxWidth: Math.min(480, result.width / result.height * 320) }}>
      <canvas ref={currentRef} role="img" aria-label="当前参数的缩小诊断预览" />
      <canvas ref={overlayRef} className="diagnostics-risk-overlay" hidden={!enabled} aria-hidden="true" />
    </div>
  )
}

function ParameterShapes({ params }) {
  const gradientId = useId()
  const curve = curvePoints(params.curve)
  const hue = Array.from({ length: 181 }, (_, index) => ({ x: index * 2,
    weight: hueWeight(index * 2, params.selective_hue_center, params.selective_hue_width) }))
  const center = (params.selective_hue_center % 360 + 360) % 360
  const curvePath = curve.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${12 + x * 276} ${92 - y * 80}`).join(' ')
  const huePath = hue.map(({ x, weight }, index) => `${index ? 'L' : 'M'} ${12 + x / 360 * 276} ${72 - weight * 52}`).join(' ')
  return (
    <div className="diagnostics-shapes">
      <figure className="diagnostics-shape">
        <figcaption><strong>S 曲线形状</strong><span>强度 {params.curve.toFixed(2)}</span></figcaption>
        <svg viewBox="0 0 300 112" role="img" aria-label={`S曲线单项形状，参数${params.curve.toFixed(2)}`}>
          <path className="diagnostics-grid" d="M12 12H288 M12 52H288 M12 92H288 M12 12V92 M150 12V92 M288 12V92" />
          <path className="diagnostics-reference" d="M12 92L288 12" />
          <path className="diagnostics-shape-line" d={curvePath} />
          <text x="12" y="108">暗部</text><text x="150" y="108" textAnchor="middle">中间调</text><text x="288" y="108" textAnchor="end">高光</text>
        </svg>
        <p>单项曲线示意；完整效果还包含其他调整与 {(params.look_strength * 100).toFixed(0)}% 风格强度。</p>
      </figure>
      <figure className="diagnostics-shape">
        <figcaption><strong>局部色彩范围</strong><span>中心 {params.selective_hue_center.toFixed(0)}° · ±{params.selective_hue_width.toFixed(0)}°</span></figcaption>
        <svg viewBox="0 0 300 112" role="img" aria-label={`局部色彩中心${params.selective_hue_center}度，半宽${params.selective_hue_width}度`}>
          <defs><linearGradient id={gradientId}>{[0, 60, 120, 180, 240, 300, 360].map((angle) => <stop key={angle} offset={`${angle / 360 * 100}%`} stopColor={`hsl(${angle},80%,54%)`} />)}</linearGradient></defs>
          <path className="diagnostics-grid" d="M12 20H288 M12 46H288 M12 72H288" />
          <path className="diagnostics-hue-area" d={`${huePath} L288 72 L12 72 Z`} />
          <path className="diagnostics-shape-line" d={huePath} />
          <rect x="12" y="79" width="276" height="8" rx="3" fill={`url(#${gradientId})`} />
          <path className="diagnostics-hue-center" d={`M${12 + center / 360 * 276} 15V90`} />
          <text x="12" y="106">0°</text><text x="150" y="106" textAnchor="middle">180°</text><text x="288" y="106" textAnchor="end">360°</text>
        </svg>
        <p>两端色相相接。低饱和颜色影响更弱；色相偏移 {params.selective_hue_shift.toFixed(0)}°，饱和调整 {params.selective_saturation.toFixed(2)}。</p>
      </figure>
    </div>
  )
}

export default function DiagnosticsPanel({ image, params, compatible, sampleName, compact = false }) {
  const [measurement, setMeasurement] = useState(null)
  const [overlay, setOverlay] = useState(false)
  const [failure, setFailure] = useState('')
  const generationRef = useRef(0)
  const normalized = useMemo(() => normalizeParams(params), [params])
  const signature = useMemo(() => parameterSignature(normalized), [normalized])
  const measurable = !!image && compatible === true
  const currentMeasurement = measurable && !failure && measurement?.image === image && measurement?.signature === signature ? measurement.result : null

  useEffect(() => {
    const id = ++generationRef.current
    setFailure('')
    if (!measurable) return undefined
    let worker, cancelled = false
    const accept = (result) => {
      if (!cancelled && generationRef.current === id) setMeasurement({ image, signature, result })
    }
    const reject = (error) => {
      if (!cancelled && generationRef.current === id) setFailure(error.message || error || '无法测量当前预览')
    }
    const timer = setTimeout(async () => {
      try {
        await preloadExternalLut(params.external_lut_id)
        if (cancelled || generationRef.current !== id) return
        let maxSide = 128
        if (typeof Worker !== 'undefined') {
          try { worker = new Worker(new URL('../workers/diagnostics.worker.js', import.meta.url), { type: 'module' }); maxSide = 256 }
          catch { /* Bounded local sampling remains available without workers. */ }
        }
        const dimensions = diagnosticDimensions(image.width, image.height, maxSide)
        const small = document.createElement('canvas')
        small.width = dimensions.width; small.height = dimensions.height
        const context = small.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('无法读取样张预览像素')
        context.drawImage(image, 0, 0, small.width, small.height)
        const pixels = context.getImageData(0, 0, small.width, small.height)
        const sample = { data: pixels.data, ...dimensions }
        if (worker) {
          worker.onmessage = ({ data }) => {
            if (data.id !== id) return
            if (data.error) reject(data.error); else accept(data.result)
            worker?.terminate()
          }
          worker.onerror = () => { reject('图像诊断未能完成，请切换样张后重试'); worker?.terminate() }
          const external = params.external_lut_id ? resolveExternalLut(params.external_lut_id) : null
          worker.postMessage({ id, image: sample, params, external }, [sample.data.buffer])
        } else accept(measureDiagnostics(sample, params))
      } catch (error) { reject(error); worker?.terminate() }
    }, 180)
    return () => { cancelled = true; clearTimeout(timer); worker?.terminate() }
  }, [image, signature, measurable])

  const details = (
    <section className="diagnostics-panel" aria-label="样张可视化诊断">
      <header className="diagnostics-heading"><div><h3>图像诊断</h3><p>{sampleName || '尚未选择样张'}</p></div><span className="diagnostics-local-tag">本机预览统计</span></header>
      {!image ? <p className="diagnostics-empty">选择真实样张后显示图像统计。下方形状仅说明当前参数。</p>
        : compatible !== true ? <p className="diagnostics-empty">请先确认样张输入，并与当前输入基准匹配。当前不进行图像测量。</p>
          : failure ? <p className="diagnostics-empty" role="alert">{failure}</p>
            : !currentMeasurement ? <p className="diagnostics-empty" role="status">正在测量当前缩小预览…</p> : null}
      {currentMeasurement && (
        <>
          <div className="diagnostics-measure-note">{currentMeasurement.width} × {currentMeasurement.height} 缩小采样 · {currentMeasurement.sampled_pixels.toLocaleString()} 个非透明像素 · {currentMeasurement.input_contract.base_photo_style} / {currentMeasurement.input_contract.output_encoding}</div>
          <div className="diagnostics-metrics">
            {[['高光溢出', 'highlight_clip_pct', 'highlight_clip_delta_pct'], ['暗部压死', 'shadow_clip_pct', 'shadow_clip_delta_pct']].map(([label, key, deltaKey]) => (
              <article key={key} className={currentMeasurement[deltaKey] > 0.5 ? 'diagnostics-metric attention' : 'diagnostics-metric'}>
                <h4>{label}占比</h4><strong>{percent(currentMeasurement.current[key])}</strong>
                <p>技术基线 {percent(currentMeasurement.baseline[key])}</p><span>{deltaText(currentMeasurement[deltaKey])}</span>
              </article>
            ))}
          </div>
          <div className="diagnostics-plot-legend"><span><i />当前效果</span><span><i className="baseline" />技术基线</span><small>横轴：编码值 · 纵轴：像素数量</small></div>
          <div className="diagnostics-histograms">{CHANNELS.map((channel) => <Histogram key={channel.key} channel={channel} baseline={currentMeasurement.baseline.histograms[channel.key]} current={currentMeasurement.current.histograms[channel.key]} />)}</div>
          <details className="diagnostics-risk-details">
            <summary>查看裁切位置与诊断预览</summary>
            <label className="diagnostics-overlay-control"><input type="checkbox" checked={overlay} onChange={(event) => setOverlay(event.target.checked)} />叠加裁切位置</label>
            <RiskPreview result={currentMeasurement} enabled={overlay} />
            <div className="diagnostics-mask-legend"><span><i />高光：任一通道 &gt; 0.98</span><span><i className="shadow" />暗部：全部通道 &lt; 0.02</span></div>
          </details>
          <p className="diagnostics-footnote">基线为相同输入基准的中性参数；V-Log 保留当前显示映射。这里只测量缩小预览，浏览器缩放与解码会影响结果。编码亮度不等于真实曝光或相机动态范围，无法恢复原图已裁切的信息，也不代表风格质量。</p>
        </>
      )}
      <ParameterShapes params={normalized} />
    </section>
  )
  if (!compact) return details
  const summary = !image ? '选择真实样张后可检查'
    : !compatible ? '输入待确认，尚未测量'
      : failure ? `诊断未完成：${failure}`
        : !currentMeasurement ? '正在测量当前预览…'
          : currentMeasurement.highlight_clip_delta_pct > 0.5 || currentMeasurement.shadow_clip_delta_pct > 0.5
            ? '新增裁切需关注' : '未发现明显新增裁切'
  return <details className="image-inspection">
    <summary><strong>图像检查</strong><span>{summary}</span>{currentMeasurement && <small>相对技术基线 · 缩小预览统计</small>}</summary>
    {details}
  </details>
}
