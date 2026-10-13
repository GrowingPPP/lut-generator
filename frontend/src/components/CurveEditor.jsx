import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { CURVE_CHANNELS, identityCurves, MAX_CURVE_POINTS, MIN_POINT_DISTANCE, prepareCurve } from '../lib/curveMath.js'
import ParameterHelp from './ParameterHelp.jsx'
import './CurveEditor.css'

const LABELS = { master: '主曲线', r: '红', g: '绿', b: '蓝' }
const TITLES = { master: '主曲线', r: 'R · 红色', g: 'G · 绿色', b: 'B · 蓝色' }
const CHANNEL_GUIDANCE = {
  master: '左侧为暗部，右侧为亮部。上抬提亮，下压变暗；三个颜色通道一起改变。',
  r: '上抬增加红色，下压偏青色。可以先在中间加点，小幅尝试。',
  g: '上抬增加绿色，下压偏洋红色。可以先在中间加点，小幅尝试。',
  b: '上抬增加蓝色，下压偏黄色。可以先在中间加点，小幅尝试。',
}
const copy = value => structuredClone(value)
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const percent = value => String(Number((value * 100).toFixed(4)))

function constrainedPoint(points, index, x, y) {
  const distance = MIN_POINT_DISTANCE * 1.01
  return [index === 0 ? 0 : index === points.length - 1 ? 1
    : clamp(x, points[index - 1][0] + distance, points[index + 1][0] - distance),
  clamp(y, index === 0 ? 0 : points[index - 1][1], index === points.length - 1 ? 1 : points[index + 1][1])]
}

function CurveChannel({ channel, points, blocked, dragging, onBegin, onMove, onFinish, onChange }) {
  const [selected, setSelected] = useState(0)
  const [pointDraft, setPointDraft] = useState({ x: '0', y: '0' })
  const [pointError, setPointError] = useState('')
  const pointIndex = Math.min(selected, points.length - 1)
  const [pointX, pointY] = points[pointIndex]
  const editingBlocked = blocked || dragging
  useEffect(() => {
    setPointDraft({ x: percent(pointX), y: percent(pointY) })
    setPointError('')
  }, [pointX, pointY, pointIndex, blocked])

  function add(event) {
    if (editingBlocked || points.length >= MAX_CURVE_POINTS) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1)
    const index = points.findIndex(point => point[0] > x)
    if (index < 1 || x - points[index - 1][0] < MIN_POINT_DISTANCE * 1.01 || points[index][0] - x < MIN_POINT_DISTANCE * 1.01) return
    const point = [x, clamp(1 - (event.clientY - rect.top) / rect.height, points[index - 1][1], points[index][1])]
    onChange(channel, current => { current.splice(index, 0, point); return current })
    setSelected(index)
  }
  function keyPoint(event, index) {
    if (editingBlocked || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 0.05 : 0.01
    onChange(channel, current => {
      const [x, y] = current[index]
      current[index] = constrainedPoint(current, index,
        x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
        y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0))
      return current
    })
    setSelected(index)
  }
  function commitCoordinate(axis) {
    if (editingBlocked) return
    const raw = pointDraft[axis].trim(), value = raw === '' ? NaN : Number(raw)
    if (!Number.isFinite(value)) { setPointError('请输入有限的百分比数值。'); return }
    onChange(channel, current => {
      const index = Math.min(selected, current.length - 1), point = current[index]
      current[index] = constrainedPoint(current, index, axis === 'x' ? value / 100 : point[0], axis === 'y' ? value / 100 : point[1])
      setPointDraft({ x: percent(current[index][0]), y: percent(current[index][1]) })
      return current
    })
    setPointError('')
  }
  const curve = prepareCurve(points)
  const path = Array.from({ length: 129 }, (_, index) => {
    const x = index / 128
    return `${index ? 'L' : 'M'} ${x * 100} ${100 - curve(x) * 100}`
  }).join(' ')
  return <section className={`curve-channel channel-${channel}`} aria-label={`${channel === 'master' ? '主曲线' : `${LABELS[channel]}色曲线`}编辑`}>
    <div className="curve-channel-heading">
      <h4><span className="curve-channel-dot" aria-hidden="true" />{TITLES[channel]}</h4>
      <span>{channel === 'master' ? '整体影调' : '分通道色彩'}</span>
    </div>
    <p className="curve-channel-learning">{CHANNEL_GUIDANCE[channel]}</p>
    <svg className="curve-editor-graph" viewBox="0 0 100 100" role="group" aria-label={`${LABELS[channel]}控制点，可用方向键调整`} onDoubleClick={add}>
      {[25, 50, 75].map(value => <path key={value} className="curve-grid" d={`M${value} 0V100 M0 ${value}H100`} />)}
      <path className="curve-identity" d="M0 100L100 0" />
      <path className="curve-line" d={path} />
      {points.map(([x, y], index) => <circle key={index} cx={x * 100} cy={100 - y * 100} r={index === pointIndex ? 2.8 : 2.2}
        className="curve-point" role="slider" tabIndex={editingBlocked ? -1 : 0} aria-label={`${LABELS[channel]}控制点 ${index + 1}，输入 ${(x * 100).toFixed(1)}%`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={y * 100} aria-disabled={editingBlocked}
        onFocus={() => setSelected(index)} onPointerDown={event => { if (onBegin(event, channel, index)) setSelected(index) }}
        onPointerMove={event => onMove(event, channel)} onPointerUp={event => onFinish(event, channel)}
        onPointerCancel={event => onFinish(event, channel, true)} onLostPointerCapture={event => onFinish(event, channel)}
        onKeyDown={event => keyPoint(event, index)} />)}
    </svg>
    <div className="curve-editor-coordinates">
      {['x', 'y'].map(axis => <label key={axis}>{axis === 'x' ? '输入 %' : '输出 %'}
        <input type="text" inputMode="decimal" data-chroma-escape-cancel="true" aria-label={`${LABELS[channel]}所选控制点${axis === 'x' ? '输入' : '输出'}百分比`}
          value={pointDraft[axis]} disabled={editingBlocked || (axis === 'x' && (pointIndex === 0 || pointIndex === points.length - 1))}
          onChange={event => setPointDraft(draft => ({ ...draft, [axis]: event.target.value }))}
          onBlur={() => commitCoordinate(axis)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPointDraft(draft => ({ ...draft, [axis]: percent(points[pointIndex][axis === 'x' ? 0 : 1]) })); setPointError('') }
          }} />
      </label>)}
      {pointError && <p className="curve-editor-help curve-coordinate-error" role="status">{pointError}</p>}
    </div>
    <div className="curve-editor-actions">
      <span>控制点 {pointIndex + 1} / {points.length}</span>
      <button type="button" disabled={editingBlocked || pointIndex === 0 || pointIndex === points.length - 1} onClick={() => {
        onChange(channel, current => { current.splice(pointIndex, 1); return current }); setSelected(Math.max(0, pointIndex - 1))
      }}>删除点</button>
      <button type="button" disabled={editingBlocked} onClick={() => {
        onChange(channel, () => identityCurves()[channel]); setSelected(0)
      }}>重置通道</button>
    </div>
  </section>
}

const CurveEditor = forwardRef(function CurveEditor({ params, disabled = false, locked = false, showHeading = true, onBegin, onPreview, onCommit, onCancel }, ref) {
  const [curves, setCurves] = useState(() => copy(params.curve_points || identityCurves()))
  const [activeChannel, setActiveChannel] = useState(null)
  const curvesRef = useRef(curves)
  const gesture = useRef(null)
  const blocked = disabled || (Array.isArray(locked) ? locked.includes('curve_points') : Boolean(locked))
  useEffect(() => {
    if (!gesture.current) { curvesRef.current = copy(params.curve_points || identityCurves()); setCurves(curvesRef.current) }
  }, [params.curve_points])

  function preview(next) {
    curvesRef.current = next; setCurves(next); onPreview?.({ curve_points: copy(next) })
  }
  function finish(cancel = false) {
    const active = gesture.current
    if (!active) return false
    gesture.current = null; setActiveChannel(null)
    if (active.element?.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer)
    if (cancel) { curvesRef.current = active.before; setCurves(active.before); onCancel?.(); return true }
    if (!equal(active.before, curvesRef.current)) onCommit?.({ curve_points: copy(curvesRef.current) })
    else onCancel?.()
    return true
  }
  useImperativeHandle(ref, () => ({ finishPendingEdit: () => finish(), cancelPendingEdit: () => finish(true) }))
  useEffect(() => {
    const cancel = event => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); finish(true) } }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  })
  useEffect(() => { if (blocked && gesture.current) finish(true) }, [blocked])

  function begin(event, channel, index) {
    if (blocked || gesture.current || event.button !== 0) return false
    event.preventDefault(); event.stopPropagation()
    gesture.current = { before: copy(curvesRef.current), channel, index, pointer: event.pointerId, element: event.currentTarget }
    setActiveChannel(channel)
    event.currentTarget.setPointerCapture(event.pointerId)
    onBegin?.()
    return true
  }
  function move(event, channel) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId || active.channel !== channel) return
    const rect = event.currentTarget.ownerSVGElement.getBoundingClientRect()
    const next = copy(curvesRef.current)
    next[channel][active.index] = constrainedPoint(next[channel], active.index,
      (event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height)
    preview(next)
  }
  function end(event, channel, cancel = false) {
    const active = gesture.current
    if (active && active.pointer === event.pointerId && active.channel === channel) finish(cancel)
  }
  function changeChannel(channel, update) {
    if (blocked || gesture.current) return
    const next = copy(curvesRef.current)
    next[channel] = update(next[channel])
    if (equal(next, curvesRef.current)) return
    curvesRef.current = next; setCurves(next); onCommit?.({ curve_points: copy(next) })
  }
  return <section className="curve-editor" aria-label="自由曲线编辑" data-chroma-escape-gesture={activeChannel !== null ? 'true' : undefined}>
    {showHeading && <div className="curve-editor-heading"><h3>自由曲线</h3><span>四通道独立调整</span></div>}
    <div className="curve-editor-instructions"><p className="curve-editor-help">双击增加控制点；拖动或用方向键调整。每通道最多16点。</p><ParameterHelp parameter="curve_points" /></div>
    <div className="curve-editor-panels">
      {CURVE_CHANNELS.map(channel => <CurveChannel key={channel} channel={channel} points={curves[channel]}
        blocked={blocked} dragging={activeChannel !== null} onBegin={begin} onMove={move} onFinish={end} onChange={changeChannel} />)}
    </div>
  </section>
})

export default CurveEditor
