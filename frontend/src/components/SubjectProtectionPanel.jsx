import { useEffect, useId, useRef, useState } from 'react'
import SelectField from './SelectField.jsx'
import CheckboxField from './ui/CheckboxField.jsx'
import { effectiveSubjectProtection, MAX_SUBJECT_REGIONS, normalizeSubjectRegions, regionFromPoints,
  regionProtectionText, SUBJECT_SELECTION_LABELS, subjectStatusText } from '../lib/subjectAnalysis.js'
import './SubjectProtectionPanel.css'

const KIND_LABELS = { face: '面部', hand: '手部', exposed_skin: '露出的皮肤' }
const EDGE_LABELS = ['左边界', '上边界', '右边界', '下边界']
const percent = value => String(Number((value * 100).toFixed(2)))
const clamp = value => Math.max(0, Math.min(1, value))

export default function SubjectProtectionPanel({ sample, previewUrl, busy = false, detecting = false,
  onDetect, onSelectionChange, onRegionsChange, onMaskModeChange }) {
  const metadata = sample?.metadata || sample || {}
  const protection = effectiveSubjectProtection(sample)
  const blocked = busy || detecting
  const canEdit = !blocked && protection.subject_mode === 'portrait' && typeof onRegionsChange === 'function'
  const [open, setOpen] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [draftRegion, setDraftRegion] = useState(null)
  const [selected, setSelected] = useState(0)
  const [coordinates, setCoordinates] = useState(['0', '0', '100', '100'])
  const [error, setError] = useState('')
  const pointer = useRef(null)
  const detailId = useId()
  const helpId = useId()
  const coordinateErrorId = useId()
  const sendingNoticeId = useId()
  const activeIndex = Math.min(selected, Math.max(0, protection.regions.length - 1))
  const activeRegion = protection.regions[activeIndex]
  const boundsSignature = JSON.stringify(activeRegion?.bounds)
  useEffect(() => { setOpen(false); setDrawing(false); setDraftRegion(null); setSelected(0); setError(''); pointer.current = null }, [metadata.id])
  useEffect(() => {
    setCoordinates(activeRegion ? activeRegion.bounds.map(percent) : ['0', '0', '100', '100'])
    setError('')
  }, [boundsSignature, activeIndex])
  useEffect(() => { if (!canEdit) { pointer.current = null; setDrawing(false); setDraftRegion(null) } }, [canEdit])

  function point(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)]
  }
  function begin(event) {
    if (!canEdit || !drawing || event.button !== 0 || protection.regions.length >= MAX_SUBJECT_REGIONS) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointer.current = { id: event.pointerId, start: point(event) }
    setDraftRegion(null)
    setError('')
  }
  function move(event) {
    if (pointer.current?.id === event.pointerId) setDraftRegion(regionFromPoints(pointer.current.start, point(event)))
  }
  function finish(event, cancel = false) {
    const gesture = pointer.current
    if (!gesture || gesture.id !== event.pointerId) return
    pointer.current = null
    const region = cancel ? null : regionFromPoints(gesture.start, point(event))
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDraftRegion(null)
    setDrawing(false)
    if (region && canEdit) {
      onRegionsChange([...protection.regions, region])
      setSelected(protection.regions.length)
    } else if (!cancel) setError('区域太小，请框选一块可见的皮肤，或使用数值添加区域。')
  }
  function commitCoordinates() {
    if (!canEdit || !activeRegion) return
    const bounds = coordinates.map(value => value.trim() === '' ? NaN : Number(value) / 100)
    const next = normalizeSubjectRegions([{ ...activeRegion, bounds }])[0]
    if (!next) { setError('边界需在 0–100% 之间，左边界小于右边界，上边界小于下边界。'); return }
    onRegionsChange(protection.regions.map((region, index) => index === activeIndex ? next : region))
    setCoordinates(next.bounds.map(percent))
    setError('')
  }
  function addWithNumbers() {
    if (!canEdit || protection.regions.length >= MAX_SUBJECT_REGIONS) return
    onRegionsChange([...protection.regions, { bounds: [.25, .25, .75, .75], kind: 'exposed_skin', confidence: 1 }])
    setSelected(protection.regions.length)
    setDrawing(false)
  }
  const width = metadata.width || metadata.photo_metadata?.width
  const height = metadata.height || metadata.photo_metadata?.height
  const aspectRatio = width > 0 && height > 0 ? `${width} / ${height}` : undefined
  const statusTone = detecting ? 'pending' : protection.subject_mode === 'unknown' ? 'attention' : 'resolved'
  return <section className="subject-protection" aria-label={`${metadata.name || '当前照片'} 人物识别与肤色保护`}>
    <div className="subject-protection-heading">
      <div><h3>人物识别与肤色保护</h3><p className={`subject-protection-status is-${statusTone}`} role="status">{subjectStatusText(sample, detecting)}</p></div>
      {onDetect && <button type="button" className="btn subject-protection-action" disabled={blocked}
        aria-describedby={sendingNoticeId} onClick={onDetect}>{detecting ? '识别中…' : protection.detection ? '重新识别' : '识别照片'}</button>}
    </div>
    <div className="subject-protection-controls"><label>照片内容<SelectField aria-label={`${metadata.name || '当前照片'} 人物识别方式`}
      value={protection.selection} disabled={blocked || !onSelectionChange} onChange={event => onSelectionChange?.(event.target.value)}>
      {Object.entries(SUBJECT_SELECTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </SelectField></label><button type="button" className="btn subject-protection-action" aria-expanded={open} aria-controls={detailId}
      onClick={() => setOpen(value => !value)}>{open ? '收起保护区域' : '查看与修正保护区域'}</button></div>
    <p className="subject-protection-summary">{regionProtectionText(sample)}</p>
    {onDetect && <p id={sendingNoticeId} className="subject-protection-help subject-protection-sending">点击识别按钮会将这张照片发送给视觉模型。</p>}
    {protection.selection === 'auto' && ['failed', 'disabled', 'uncertain'].includes(protection.status)
      && <p className="subject-protection-notice">可重试识别，或将照片内容改为人工确认；调色仍可继续。</p>}
    <div id={detailId} className="subject-protection-details" hidden={!open}>
      <p id={helpId} className="subject-protection-help">框只覆盖面部、手部等露出的皮肤，避开头发、衣服和暖色背景。区域用于检查肤色变化，LUT 仍对整张照片调色。</p>
      {previewUrl ? <div className={`subject-region-preview ${drawing ? 'is-drawing' : ''}`} style={{ aspectRatio }}>
        <img src={previewUrl} alt={`${metadata.name || '当前照片'} 原图，供定位肤色保护区域`} draggable="false" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="subject-region-overlay" role="img"
          aria-label={`肤色保护区域示意，共 ${protection.regions.length} 个区域`} aria-describedby={helpId}
          onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={event => finish(event, true)}
          onLostPointerCapture={event => finish(event, true)}>
          {protection.regions.map((region, index) => <g key={index} className={index === activeIndex ? 'is-selected' : ''}>
            <rect x={region.bounds[0] * 100} y={region.bounds[1] * 100} width={(region.bounds[2] - region.bounds[0]) * 100}
              height={(region.bounds[3] - region.bounds[1]) * 100} vectorEffect="non-scaling-stroke" />
            <text x={region.bounds[0] * 100 + 1} y={region.bounds[1] * 100 + 4}>{index + 1}</text>
          </g>)}
          {draftRegion && <rect className="subject-region-draft" x={draftRegion.bounds[0] * 100} y={draftRegion.bounds[1] * 100}
            width={(draftRegion.bounds[2] - draftRegion.bounds[0]) * 100} height={(draftRegion.bounds[3] - draftRegion.bounds[1]) * 100}
            vectorEffect="non-scaling-stroke" />}
        </svg>
      </div> : <p className="subject-protection-notice">绑定照片后可以在原图上查看和框选区域；也可以用下方百分比数值编辑。</p>}
      <div className="subject-region-actions"><button type="button" className={`btn subject-protection-action ${drawing ? 'is-active' : ''}`}
        disabled={!canEdit || !previewUrl || protection.regions.length >= MAX_SUBJECT_REGIONS} aria-pressed={drawing}
        onClick={() => { setDrawing(value => !value); setError('') }}>{drawing ? '取消框选' : '在照片上画框'}</button>
        <button type="button" className="btn subject-protection-action" disabled={!canEdit || protection.regions.length >= MAX_SUBJECT_REGIONS}
          onClick={addWithNumbers}>用数值添加区域</button>
        <button type="button" className="btn subject-protection-action" disabled={!canEdit || !protection.regions.length}
          onClick={() => { onRegionsChange([]); setSelected(0); setDrawing(false) }}>清空区域</button>
        {protection.manual_regions && <button type="button" className="btn subject-protection-action" disabled={blocked || !onRegionsChange}
          onClick={() => { onRegionsChange(null); setSelected(0); setDrawing(false) }}>恢复自动区域</button>}
      </div>
      {drawing && <p className="subject-protection-notice" role="status">在照片上按住并拖动，框选一块露出的皮肤。触屏也可以拖动；键盘可使用“用数值添加区域”。</p>}
      {protection.subject_mode !== 'portrait' && <p className="subject-protection-help">需要人工补充保护区域时，请先将照片内容改为“包含人物（人工修正）”。</p>}
      {protection.regions.length > 0 && <div className="subject-region-list" aria-label="选择肤色保护区域">{protection.regions.map((region, index) =>
        <button key={index} type="button" aria-pressed={index === activeIndex} className="subject-region-choice" disabled={blocked}
          onClick={() => { setSelected(index); setError('') }} aria-label={`选择保护区域 ${index + 1}，${KIND_LABELS[region.kind]}`}>
          <span>{index + 1}</span>{KIND_LABELS[region.kind]}</button>)}</div>}
      {activeRegion && <div className="subject-region-editor"><div className="subject-region-editor-heading"><strong>保护区域 {activeIndex + 1}</strong>
        <button type="button" className="btn subject-protection-action" disabled={!canEdit} aria-label={`删除保护区域 ${activeIndex + 1}`}
          onClick={() => { onRegionsChange(protection.regions.filter((_, index) => index !== activeIndex)); setSelected(Math.max(0, activeIndex - 1)); setDrawing(false) }}>删除区域</button></div>
        <div className="subject-region-coordinates">{EDGE_LABELS.map((label, index) => <label key={label}>{label} %
          <input type="text" inputMode="decimal" value={coordinates[index]} disabled={!canEdit} data-chroma-escape-cancel="true"
            aria-label={`保护区域 ${activeIndex + 1} ${label}百分比`} aria-describedby={error ? coordinateErrorId : undefined}
            aria-invalid={error ? true : undefined} onChange={event => setCoordinates(values => values.map((value, edge) => edge === index ? event.target.value : value))}
            onBlur={commitCoordinates} onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
              if (event.key === 'Escape') { event.preventDefault(); setCoordinates(activeRegion.bounds.map(percent)); setError('') }
            }} />
        </label>)}</div></div>}
      {error && <p id={coordinateErrorId} className="subject-protection-error" role="alert">{error}</p>}
      {protection.manual_regions && protection.subject_mode === 'portrait' && onMaskModeChange && <label className="subject-region-mask-control">
        <CheckboxField checked={protection.mask_mode === 'all_pixels'} disabled={blocked || !protection.regions.length}
          onChange={event => onMaskModeChange(event.target.checked ? 'all_pixels' : 'skin_candidates')} />
        <span>框内全部像素参与保护<small>深肤色或特殊光线下可启用；请缩小框，避免混入背景。默认只检查框内的肤色候选像素。</small></span>
      </label>}
      <p className="subject-protection-help">自动定位是近似区域，可随时修正。重新识别不会覆盖人工画的框；“恢复自动区域”会使用最近一次识别结果。</p>
    </div>
  </section>
}
