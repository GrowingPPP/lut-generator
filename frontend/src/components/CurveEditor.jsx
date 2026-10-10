import { useEffect, useRef, useState } from 'react'
import { CURVE_CHANNELS, identityCurves, MAX_CURVE_POINTS, MIN_POINT_DISTANCE, prepareCurve } from '../lib/curveMath.js'
import './CurveEditor.css'

const LABELS = { master: '主曲线', r: '红', g: '绿', b: '蓝' }
const copy = value => structuredClone(value)
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export default function CurveEditor({ params, disabled = false, locked = false, onBegin, onPreview, onCommit, onCancel }) {
  const [channel, setChannel] = useState('master')
  const [selected, setSelected] = useState(0)
  const [curves, setCurves] = useState(() => copy(params.curve_points || identityCurves()))
  const [pointDraft, setPointDraft] = useState({ x: '0', y: '0' })
  const [pointError, setPointError] = useState('')
  const curvesRef = useRef(curves)
  const gesture = useRef(null)
  const blocked = disabled || (Array.isArray(locked) ? locked.includes('curve_points') : Boolean(locked))
  useEffect(() => {
    const point = curves[channel][Math.min(selected, curves[channel].length - 1)]
    setPointDraft({ x: String(Number((point[0] * 100).toFixed(4))), y: String(Number((point[1] * 100).toFixed(4))) })
    setPointError('')
  }, [curves, channel, selected])
  useEffect(() => {
    if (!gesture.current) { curvesRef.current = copy(params.curve_points); setCurves(curvesRef.current) }
  }, [params.curve_points])

  function preview(next) {
    curvesRef.current = next; setCurves(next); onPreview?.({ curve_points: copy(next) })
  }
  function finish(cancel = false) {
    const active = gesture.current
    if (!active) return
    gesture.current = null
    if (cancel) { curvesRef.current = active.before; setCurves(active.before); onCancel?.(); return }
    if (!equal(active.before, curvesRef.current)) onCommit?.({ curve_points: copy(curvesRef.current) })
    else onCancel?.()
  }
  useEffect(() => {
    const cancel = event => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); finish(true) } }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  })
  useEffect(() => {
    if (blocked && gesture.current) finish(true)
  }, [blocked])

  function constrainedPoint(points, index, x, y) {
    const distance = MIN_POINT_DISTANCE * 1.01
    return [index === 0 ? 0 : index === points.length - 1 ? 1
      : clamp(x, points[index - 1][0] + distance, points[index + 1][0] - distance),
    clamp(y, index === 0 ? 0 : points[index - 1][1], index === points.length - 1 ? 1 : points[index + 1][1])]
  }
  function coordinates(event) {
    const rect = event.currentTarget.ownerSVGElement.getBoundingClientRect()
    return [(event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height]
  }
  function begin(event, index) {
    if (blocked) return
    event.preventDefault(); event.stopPropagation()
    setSelected(index)
    gesture.current = { before: copy(curvesRef.current), channel, index, pointer: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
    onBegin?.()
  }
  function move(event) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId) return
    const next = copy(curvesRef.current)
    next[active.channel][active.index] = constrainedPoint(next[active.channel], active.index, ...coordinates(event))
    preview(next)
  }
  function commit(next) {
    if (blocked || equal(next, curvesRef.current)) return
    curvesRef.current = next; setCurves(next); onCommit?.({ curve_points: copy(next) })
  }
  function add(event) {
    if (blocked || curves[channel].length >= MAX_CURVE_POINTS || gesture.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    const points = curves[channel]
    const index = points.findIndex(point => point[0] > x)
    if (index < 1 || x - points[index - 1][0] < MIN_POINT_DISTANCE * 1.01 || points[index][0] - x < MIN_POINT_DISTANCE * 1.01) return
    const next = copy(curves)
    next[channel].splice(index, 0, [x, clamp(1 - (event.clientY - rect.top) / rect.height, points[index - 1][1], points[index][1])])
    setSelected(index); commit(next)
  }
  function keyPoint(event, index) {
    if (blocked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = copy(curves), step = event.shiftKey ? 0.05 : 0.01
    const [x, y] = next[channel][index]
    next[channel][index] = constrainedPoint(next[channel], index,
      x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
      y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0))
    setSelected(index); commit(next)
  }
  function commitCoordinate(axis) {
    if (blocked) return
    const raw = pointDraft[axis].trim(), value = raw === '' ? NaN : Number(raw)
    if (!Number.isFinite(value)) {
      setPointError('请输入有限的百分比数值。')
      return
    }
    const next = copy(curves), index = Math.min(selected, next[channel].length - 1)
    const point = next[channel][index]
    next[channel][index] = constrainedPoint(next[channel], index, axis === 'x' ? value / 100 : point[0], axis === 'y' ? value / 100 : point[1])
    setPointError('')
    setPointDraft({ x: String(Number((next[channel][index][0] * 100).toFixed(4))), y: String(Number((next[channel][index][1] * 100).toFixed(4))) })
    commit(next)
  }
  const points = curves[channel], pointIndex = Math.min(selected, points.length - 1)
  const curve = prepareCurve(points)
  const path = Array.from({ length: 129 }, (_, index) => {
    const x = index / 128
    return `${index ? 'L' : 'M'} ${x * 100} ${100 - curve(x) * 100}`
  }).join(' ')
  return <section className="curve-editor" aria-label="自由曲线编辑">
    <div className="curve-editor-heading"><h3>自由曲线</h3><span>单调 · PCHIP</span></div>
    <div className="curve-editor-channels" role="group" aria-label="曲线通道">
      {CURVE_CHANNELS.map(key => <button type="button" key={key} aria-pressed={channel === key} disabled={Boolean(gesture.current)}
        onClick={() => { setChannel(key); setSelected(0) }}>{LABELS[key]}</button>)}
    </div>
    <svg className={`curve-editor-graph channel-${channel}`} viewBox="0 0 100 100" role="group" aria-label={`${LABELS[channel]}控制点，可用方向键调整`} onDoubleClick={add}>
      {[25, 50, 75].map(value => <path key={value} className="curve-grid" d={`M${value} 0V100 M0 ${value}H100`} />)}
      <path className="curve-identity" d="M0 100L100 0" />
      <path className="curve-line" d={path} />
      {points.map(([x, y], index) => <circle key={index} cx={x * 100} cy={100 - y * 100} r={index === pointIndex ? 2.8 : 2.2}
        className="curve-point" role="slider" tabIndex={blocked ? -1 : 0} aria-label={`${LABELS[channel]}控制点 ${index + 1}，输入 ${(x * 100).toFixed(1)}%`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={y * 100} aria-disabled={blocked}
        onFocus={() => setSelected(index)} onPointerDown={event => begin(event, index)} onPointerMove={move}
        onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()}
        onKeyDown={event => keyPoint(event, index)} />)}
    </svg>
    <p className="curve-editor-help">双击增加控制点；拖动或用方向键调整。每通道最多16点，输出不能下降。</p>
    <div className="curve-editor-coordinates">
      {['x', 'y'].map(axis => <label key={axis}>{axis === 'x' ? '输入 %' : '输出 %'}
        <input type="text" inputMode="decimal" aria-label={`${LABELS[channel]}所选控制点${axis === 'x' ? '输入' : '输出'}百分比`}
          value={pointDraft[axis]} disabled={blocked || (axis === 'x' && (pointIndex === 0 || pointIndex === points.length - 1))}
          onChange={event => setPointDraft(draft => ({ ...draft, [axis]: event.target.value }))}
          onBlur={() => commitCoordinate(axis)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPointDraft(draft => ({ ...draft, [axis]: String(Number((points[pointIndex][axis === 'x' ? 0 : 1] * 100).toFixed(4))) })); setPointError('') }
          }} />
      </label>)}
    </div>
    {pointError && <p className="curve-editor-help" role="status">{pointError}</p>}
    <div className="curve-editor-actions">
      <span>输入 {(points[pointIndex][0] * 100).toFixed(1)}% · 输出 {(points[pointIndex][1] * 100).toFixed(1)}%</span>
      <button type="button" disabled={blocked || pointIndex === 0 || pointIndex === points.length - 1} onClick={() => {
        const next = copy(curves); next[channel].splice(pointIndex, 1); setSelected(Math.max(0, pointIndex - 1)); commit(next)
      }}>删除点</button>
      <button type="button" disabled={blocked} onClick={() => {
        const next = copy(curves); next[channel] = identityCurves()[channel]; setSelected(0); commit(next)
      }}>重置通道</button>
    </div>
  </section>
}
