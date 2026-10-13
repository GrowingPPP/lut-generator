import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import SelectField from './SelectField.jsx'
import { ModalSurface } from './ui/Dialog.jsx'
import RangeField from './ui/RangeField.jsx'
import Tooltip from './ui/Tooltip.jsx'
import ActionIcon from './ui/ActionIcon.jsx'
import { generateLUT } from '../lib/lutEngine.js'
import { LUTRenderer } from '../lib/lutPreview.js'
import { preloadExternalLut } from '../lib/importedLuts.js'
import { normalizePhoto } from '../lib/photoApi.js'
import { clampPhotoPan, fitPhotoScale, photoFramePoint, photoTransform, photoViewerMode, zoomPhotoAt } from '../lib/photoViewport.js'
import './PhotoViewer.css'

function RawPixels({ image, label }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const canvas = ref.current
    canvas.width = image.width; canvas.height = image.height
    canvas.getContext('2d').drawImage(image, 0, 0)
    return () => { canvas.width = 1; canvas.height = 1 }
  }, [image])
  return <canvas className="photo-viewer-pixels" ref={ref} role="img" aria-label={label} />
}

function EffectPixels({ image, params, label, onStatus }) {
  const ref = useRef(null)
  const resource = useRef(null)
  const signature = JSON.stringify(params)
  const snapshot = useMemo(() => JSON.parse(signature), [signature])
  useEffect(() => {
    const canvas = ref.current
    const current = { image, renderer: null, ready: false, error: '', lastLut: null, encoding: 'sRGB' }
    resource.current = current
    try {
      current.renderer = new LUTRenderer(canvas)
      const gl = current.renderer.gl
      const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
      const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...viewport)
      if (Math.max(image.width, image.height) > limit)
        throw new Error(`照片尺寸超过当前设备的 GPU 上限 ${limit}px，保留原图。请使用当前预览分辨率。`)
      current.renderer.setImage(image)
      current.renderer.setSplitMode(false)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('设备无法载入此尺寸的照片，请使用当前预览分辨率。')
    } catch (error) {
      current.renderer?.dispose(); current.renderer = null
      current.error = error.message || '照片载入失败'
    }
    return () => {
      if (resource.current === current) resource.current = null
      current.renderer?.dispose()
      canvas.width = 1; canvas.height = 1
    }
  }, [image])
  useEffect(() => {
    const current = resource.current
    let cancelled = false, scheduled = 0
    const status = state => onStatus({ ...state, ready: current?.ready || false, image, signature })
    if (!current?.renderer) {
      status({ loading: false, error: current?.error || '照片载入失败' })
      return undefined
    }
    status({ loading: true, error: '' })
    const render = async () => {
      let changedLut = false
      try {
        await preloadExternalLut(snapshot.external_lut_id)
        if (cancelled || resource.current !== current) return
        scheduled = requestAnimationFrame(() => {
          if (cancelled || resource.current !== current) return
          try {
            const renderer = current.renderer, gl = renderer.gl
            const lut = generateLUT(snapshot, 33)
            const encoding = snapshot.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB'
            changedLut = true
            renderer.setLUT(lut.data, lut.size)
            renderer.setDisplayEncoding(encoding)
            renderer.render()
            if (gl.getError() !== gl.NO_ERROR || gl.isContextLost())
              throw new Error('设备无法渲染此尺寸的照片，请使用当前预览分辨率。')
            current.lastLut = lut; current.encoding = encoding; current.ready = true
            status({ loading: false, error: '' })
          } catch (error) { failed(error) }
        })
      } catch (error) { failed(error) }
    }
    const failed = error => {
      if (cancelled || resource.current !== current) return
      if (changedLut && current.lastLut) {
        try {
          const renderer = current.renderer, gl = renderer.gl
          renderer.setLUT(current.lastLut.data, current.lastLut.size)
          renderer.setDisplayEncoding(current.encoding)
          renderer.render()
          current.ready = gl.getError() === gl.NO_ERROR && !gl.isContextLost()
        } catch { current.ready = false }
      }
      if (!current.ready) current.renderer.clear()
      status({ loading: false, error: error.message || '效果载入失败' })
    }
    render()
    return () => { cancelled = true; cancelAnimationFrame(scheduled) }
  }, [image, snapshot, signature, onStatus])
  return <canvas className="photo-viewer-pixels" ref={ref} role="img" aria-label={label} />
}

function gpuPhotoLimit() {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('当前设备不支持效果渲染，保留当前预览。')
  const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS))
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return limit
}

export default function PhotoViewer({ sample, media, params, compatible, comparison, onClose, initialMode = 'slider', initialSplit = 0.5,
  adjustmentPanel, canUndo = false, canRedo = false, onUndo, onRedo, onEditDraft, onFinishAdjustment }) {
  const id = useId()
  const modalRef = useRef(null)
  const synthetic = useRef(media?.canvas)
  const preview = sample ? media?.canvas : synthetic.current
  const file = media?.file
  const digest = sample?.source_digest
  const inputStyle = sample?.input_contract?.base_photo_style || params.base_photo_style
  const hasComparison = !!comparison?.a?.params && !!comparison?.b?.params
  const aParams = hasComparison ? comparison.a.params : null
  const bParams = hasComparison ? comparison.b.params : params
  const aLabel = hasComparison ? `A · ${comparison.a.name || '未命名版本'}` : '原图'
  const bLabel = hasComparison ? `B · ${comparison.b.name || '未命名版本'}` : '当前效果'
  const [image, setImage] = useState(preview)
  const [original, setOriginal] = useState(false)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [mode, setMode] = useState(() => photoViewerMode(initialMode, window.innerWidth < 700))
  const [split, setSplit] = useState(Math.max(0, Math.min(1, initialSplit)))
  const [view, setView] = useState({ scale: 1, x: 0, y: 0, fit: true })
  const [frame, setFrame] = useState({ width: 1, height: 1 })
  const [dragging, setDragging] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => !!adjustmentPanel && window.innerWidth >= 1000)
  const [aState, setAState] = useState({ loading: hasComparison && compatible, error: '' })
  const [bState, setBState] = useState({ loading: compatible, error: '' })
  const stageRef = useRef(null)
  const [stageElement, setStageElement] = useState(null)
  const attachStage = useCallback(node => { stageRef.current = node; setStageElement(node) }, [])
  const drag = useRef(null)
  const request = useRef(null)
  const objectUrl = useRef(null)
  const decodedImage = useRef(null)
  const generation = useRef(0)
  const fullImage = useRef(null)
  const activeView = useRef(view)
  activeView.current = view
  const setAStatus = useCallback(state => setAState(state), [])
  const setBStatus = useCallback(state => setBState(state), [])
  const aCurrent = aState.image === image && aState.signature === JSON.stringify(aParams)
  const bCurrent = bState.image === image && bState.signature === JSON.stringify(bParams)
  const renderError = compatible && ((hasComparison && aCurrent && aState.error) || (bCurrent && bState.error))
  const renderLoading = compatible && (!bCurrent || bState.loading || (hasComparison && (!aCurrent || aState.loading)))
  const renderReady = bState.image === image && bState.ready && (!hasComparison || (aState.image === image && aState.ready))
  const fallback = !compatible || !renderReady
  const visibleMode = fallback ? 'original' : mode
  const photoSize = { width: image?.width || 1, height: image?.height || 1 }
  const transform = photoTransform(view, photoSize, frame)
  const sourceWidth = sample?.source_width || sample?.photo_metadata?.source_width
  const sourceHeight = sample?.source_height || sample?.photo_metadata?.source_height
  const historyAvailable = !hasComparison && !!adjustmentPanel

  const finishAdjustment = useCallback(() => {
    const focused = document.activeElement
    if (modalRef.current?.contains(focused)) focused.blur?.()
    onFinishAdjustment?.()
  }, [modalRef, onFinishAdjustment])
  const close = useCallback(() => { finishAdjustment(); onClose() }, [finishAdjustment, onClose])
  useEffect(() => {
    generation.current++
    request.current?.abort()
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null }
    if (decodedImage.current) { decodedImage.current.src = ''; decodedImage.current = null }
    if (fullImage.current) { fullImage.current.width = 1; fullImage.current.height = 1 }
    fullImage.current = null
    setImage(preview); setOriginal(false); setSourceLoading(false); setSourceError('')
    setView({ scale: 1, x: 0, y: 0, fit: true })
    return () => {
      generation.current++
      request.current?.abort()
      if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null }
      if (decodedImage.current) { decodedImage.current.src = ''; decodedImage.current = null }
      if (fullImage.current) { fullImage.current.width = 1; fullImage.current.height = 1; fullImage.current = null }
    }
  }, [preview, file, digest, inputStyle])

  useEffect(() => {
    const stage = stageElement
    if (!stage) return
    const measure = () => {
      const rect = stage.getBoundingClientRect()
      setFrame({ width: Math.max(1, visibleMode === 'side-by-side' ? (rect.width - 1) / 2 : rect.width), height: Math.max(1, rect.height) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [visibleMode, stageElement])

  useEffect(() => {
    setView(current => current.fit
      ? { scale: fitPhotoScale(photoSize, frame), x: 0, y: 0, fit: true }
      : clampPhotoPan(current, photoSize, frame))
  }, [image?.width, image?.height, frame.width, frame.height])

  const fit = () => setView({ scale: fitPhotoScale(photoSize, frame), x: 0, y: 0, fit: true })
  const zoom = (next, anchor = { x: frame.width / 2, y: frame.height / 2 }) =>
    setView(current => zoomPhotoAt(current, next, anchor, photoSize, frame))

  const loadOriginal = async (pixelOne = false) => {
    if (!file) { setView({ scale: 1, x: 0, y: 0, fit: false }); return }
    if (sourceLoading) return
    if (fullImage.current) {
      setImage(fullImage.current); setOriginal(true)
      setView({ scale: pixelOne ? 1 : fitPhotoScale(fullImage.current, frame), x: 0, y: 0, fit: !pixelOne })
      return
    }
    const token = generation.current
    const controller = new AbortController()
    request.current?.abort(); request.current = controller
    setSourceLoading(true); setSourceError('')
    let url
    try {
      if (!digest) throw new Error('照片缺少来源信息，请先重新绑定原文件。')
      const limit = compatible ? gpuPhotoLimit() : Infinity
      if (sourceWidth && sourceHeight && Math.max(sourceWidth, sourceHeight) > limit)
        throw new Error(`原照片超过当前设备的 GPU 上限 ${limit}px，继续显示 ${preview.width} × ${preview.height} 预览。`)
      const result = await normalizePhoto(file, inputStyle, digest, { resolution: 'original', signal: controller.signal })
      if (controller.signal.aborted || token !== generation.current) return
      if (Math.max(result.metadata.width, result.metadata.height) > limit)
        throw new Error(`原照片超过当前设备的 GPU 上限 ${limit}px，继续显示当前预览。`)
      url = URL.createObjectURL(result.blob)
      objectUrl.current = url
      const decoded = new Image()
      decodedImage.current = decoded
      decoded.src = url
      await decoded.decode()
      if (controller.signal.aborted || token !== generation.current) return
      if (decoded.naturalWidth !== result.metadata.width || decoded.naturalHeight !== result.metadata.height)
        throw new Error('原分辨率照片尺寸与规范化结果不一致，继续显示当前预览。')
      const canvas = document.createElement('canvas')
      canvas.width = decoded.naturalWidth; canvas.height = decoded.naturalHeight
      canvas.getContext('2d').drawImage(decoded, 0, 0)
      fullImage.current = canvas
      setImage(canvas); setOriginal(true)
      setView({ scale: pixelOne ? 1 : fitPhotoScale(canvas, frame), x: 0, y: 0, fit: !pixelOne })
    } catch (error) {
      if (!controller.signal.aborted && token === generation.current) setSourceError(error.message || '原分辨率载入失败，继续显示当前预览。')
    } finally {
      if (url) URL.revokeObjectURL(url)
      if (objectUrl.current === url) objectUrl.current = null
      if (token === generation.current) decodedImage.current = null
      if (token === generation.current && !controller.signal.aborted) setSourceLoading(false)
    }
  }

  const localPoint = event => {
    return photoFramePoint({ x: event.clientX, y: event.clientY }, stageRef.current.getBoundingClientRect(), visibleMode === 'side-by-side')
  }
  const startPan = event => {
    if (event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    stageRef.current.focus({ preventScroll: true })
    stageRef.current.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view: activeView.current }
    setDragging(true)
  }
  const movePan = event => {
    const start = drag.current
    if (!start || start.id !== event.pointerId) return
    setView(clampPhotoPan({ ...start.view, fit: false, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y }, photoSize, frame))
  }
  const endPan = event => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null; setDragging(false)
    if (stageRef.current.hasPointerCapture(event.pointerId)) stageRef.current.releasePointerCapture(event.pointerId)
  }
  const wheel = event => {
    event.preventDefault()
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1)
    zoom(activeView.current.scale * Math.exp(-Math.max(-300, Math.min(300, pixels)) * 0.002), localPoint(event))
  }
  useEffect(() => {
    const stage = stageElement
    if (!stage) return
    stage.addEventListener('wheel', wheel, { passive: false })
    return () => stage.removeEventListener('wheel', wheel)
  })

  const key = event => {
    if (event.defaultPrevented) return
    const formField = event.target.closest?.('input, select, textarea, [contenteditable="true"], [role="slider"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [data-chroma-popover-content]')
    const nativeUndo = formField && formField.getAttribute('role') !== 'slider' && !(formField.tagName === 'INPUT' && formField.type === 'range')
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z' && !nativeUndo && historyAvailable) {
      event.preventDefault()
      if (event.shiftKey) { if (canRedo) { finishAdjustment(); onRedo?.() } }
      else if (canUndo) { finishAdjustment(); onUndo?.() }
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey || formField || event.target.closest?.('.photo-viewer-adjustments')) return
    if (['+', '=', '-', '_', '0', '1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault()
    if (event.key === '+' || event.key === '=') zoom(view.scale * 1.25)
    if (event.key === '-' || event.key === '_') zoom(view.scale / 1.25)
    if (event.key === '0') fit()
    if (event.key === '1') loadOriginal(true)
    const distance = event.shiftKey ? 120 : 40
    const directions = { ArrowLeft: [distance, 0], ArrowRight: [-distance, 0], ArrowUp: [0, distance], ArrowDown: [0, -distance] }
    if (directions[event.key]) {
      const [x, y] = directions[event.key]
      setView(current => clampPhotoPan({ ...current, x: current.x + x, y: current.y + y, fit: false }, photoSize, frame))
    }
  }
  const previewAgain = () => { setImage(preview); setOriginal(false); setSourceError(''); setView({ scale: 1, x: 0, y: 0, fit: true }) }
  const resolution = !sample ? '合成示意图' : original ? '原分辨率' : !file ? '缓存预览 · 无原文件' : '规范化预览'
  const percent = Math.round(view.scale * 1000) / 10
  const modes = [['slider', '滑动对比', 'split'], ['side-by-side', '并排', 'compare'], ['original', hasComparison && !fallback ? '仅 A' : '仅原图', 'image'], ['effect', hasComparison ? '仅 B' : '仅效果', 'adjust']]

  return <ModalSurface onClose={close} contentRef={modalRef} overlayClassName="photo-viewer-backdrop">
    <section className={`photo-viewer${panelOpen && adjustmentPanel ? ' has-adjustments' : ''}`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} onKeyDown={key}>
      <header className="photo-viewer-header">
        <div className="photo-viewer-title"><h2 id={`${id}-title`}>放大查看</h2><span title={sample?.name}>{sample?.name || '调色示意图'}</span></div>
        <div className="photo-viewer-header-actions">
          {adjustmentPanel && <button type="button" className={`photo-viewer-button ${panelOpen ? 'btn-soft' : 'btn-ghost'}`} aria-pressed={panelOpen} aria-expanded={panelOpen} aria-controls={`${id}-adjustments`} onClick={() => { if (panelOpen) finishAdjustment(); setPanelOpen(value => !value) }}><ActionIcon name="adjust" />调色面板{panelOpen ? ' · 收起' : ''}</button>}
          <button type="button" className="photo-viewer-button btn-ghost photo-viewer-close" onClick={close}><ActionIcon name="close" />关闭</button>
        </div>
      </header>
      <div className="photo-viewer-tools">
        <div className="photo-viewer-modes" role="group" aria-label="照片查看模式">{modes.map(([value, label, icon]) => <button type="button" key={value} className={`photo-viewer-button ${visibleMode === value ? 'btn-soft' : 'btn-ghost'}`} aria-pressed={visibleMode === value} disabled={(!compatible || (!!renderError && !renderReady)) && value !== 'original'} onClick={() => setMode(value)}><ActionIcon name={icon} />{label}</button>)}</div>
        <div className="photo-viewer-zoom" role="group" aria-label="照片缩放">
          <button type="button" className={`photo-viewer-button ${view.fit ? 'btn-soft' : 'btn-ghost'}`} aria-pressed={view.fit} onClick={fit}><ActionIcon name="fit" />适应窗口</button>
          <Tooltip content="按照片像素查看细节；有原文件时载入原分辨率"><button type="button" className={`photo-viewer-button ${!view.fit && view.scale === 1 ? 'btn-soft' : 'btn-ghost'}`} aria-pressed={!view.fit && view.scale === 1} disabled={sourceLoading} onClick={() => loadOriginal(true)}><ActionIcon name="pixels" />{file ? '1:1 像素' : sample ? '预览 1:1' : '示意图 1:1'}</button></Tooltip>
          <button type="button" className="photo-viewer-button btn-ghost photo-viewer-step" aria-label="缩小照片" onClick={() => zoom(view.scale / 1.25)} disabled={view.scale <= 0.25}><ActionIcon name="zoom-out" /><span className="photo-viewer-step-label">缩小</span></button>
          <label className="photo-viewer-scale"><span className="photo-viewer-sr-only">缩放比例</span><SelectField aria-label="照片缩放比例" value={String(percent)} onChange={event => zoom(Number(event.target.value) / 100)}>
            {![25, 50, 75, 100, 150, 200, 300, 400].includes(percent) && <option value={percent}>{percent}%</option>}
            {[25, 50, 75, 100, 150, 200, 300, 400].map(value => <option value={value} key={value}>{value}%</option>)}
          </SelectField></label>
          <button type="button" className="photo-viewer-button btn-ghost photo-viewer-step" aria-label="放大照片" onClick={() => zoom(view.scale * 1.25)} disabled={view.scale >= 4}><ActionIcon name="zoom-in" /><span className="photo-viewer-step-label">放大</span></button>
        </div>
      </div>
      <div className="photo-viewer-status" aria-live="polite">
        <span>{resolution} · {image?.width} × {image?.height}px · {percent}%{view.fit ? ' · 适应窗口' : ''}</span>
        {file && !original && <button type="button" className="photo-viewer-button btn-soft" disabled={sourceLoading} onClick={() => loadOriginal(false)}><ActionIcon name="pixels" />{sourceLoading ? '正在载入原分辨率…' : '载入原分辨率'}</button>}
        {original && <button type="button" className="photo-viewer-button btn-ghost" onClick={previewAgain}><ActionIcon name="image" />使用预览分辨率</button>}
        {sourceWidth && sourceHeight && !original && <span className="photo-viewer-source-size">原照片 {sourceWidth} × {sourceHeight}px</span>}
      </div>
      <div className="photo-viewer-content">
      <div className="photo-viewer-main">
      {!compatible && <p className="photo-viewer-notice">输入尚未确认或与当前参数不兼容，当前仅显示原图，暂不可调色。请关闭查看器后确认照片输入基准。</p>}
      {sourceError && <p className="photo-viewer-error" role="alert">{sourceError}</p>}
      {renderError && <p className="photo-viewer-error" role="alert">效果载入失败：{renderError} {renderReady ? '保留上一次成功效果。' : '当前显示原图。'}</p>}
      {renderLoading && <p className={`photo-viewer-notice${renderReady ? ' photo-viewer-updating' : ''}`} role="status">{renderReady ? '正在更新效果…' : '正在载入完整效果，暂时显示原图…'}</p>}
      <div ref={attachStage} className={`photo-viewer-stage photo-viewer-${visibleMode}${dragging ? ' is-dragging' : ''}`} tabIndex={0} role="region" aria-label="照片查看区域" onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={() => { drag.current = null; setDragging(false) }}>
        <div className="photo-viewer-frame photo-viewer-a">
          <div className="photo-viewer-image" style={{ width: photoSize.width, height: photoSize.height, transform }}>
            <div className="photo-viewer-layer" hidden={hasComparison && compatible && !fallback}><RawPixels image={image} label="规范化原图" /></div>
            {hasComparison && compatible && <div className="photo-viewer-layer" hidden={fallback}><EffectPixels image={image} params={aParams} label={aLabel} onStatus={setAStatus} /></div>}
          </div>
          <span className="photo-viewer-label">{fallback ? '原图' : aLabel}</span>
        </div>
        <div className="photo-viewer-frame photo-viewer-b" style={visibleMode === 'slider' ? { clipPath: `inset(0 0 0 ${split * 100}%)` } : undefined}>
          <div className="photo-viewer-image" style={{ width: photoSize.width, height: photoSize.height, transform }}>
            {compatible && <EffectPixels image={image} params={bParams} label={bLabel} onStatus={setBStatus} />}
          </div>
          <span className="photo-viewer-label">{bLabel}</span>
        </div>
        {visibleMode === 'slider' && <div className="photo-viewer-divider" style={{ left: `${split * 100}%` }} aria-hidden="true" />}
      </div>
      <footer className="photo-viewer-footer">
        {compatible && visibleMode === 'slider' && <div className="photo-viewer-split"><label htmlFor={`${id}-split`}>{aLabel} / {bLabel}</label><RangeField id={`${id}-split`} min="0" max="100" value={Math.round(split * 100)} onChange={event => setSplit(Number(event.target.value) / 100)} aria-label="照片对比分界" aria-valuetext={`左侧 ${Math.round(split * 100)}%，右侧 ${Math.round((1 - split) * 100)}%`} /></div>}
        <p id={`${id}-help`}>滚轮缩放 · 拖动平移 · + / − 缩放 · 0 适应 · 1 {file ? '原像素' : '预览像素'} · 方向键平移 · Esc 关闭</p>
      </footer>
      </div>
      {adjustmentPanel && panelOpen && <aside id={`${id}-adjustments`} className="photo-viewer-adjustments" aria-label="放大查看调色面板">
        <div className="photo-viewer-adjustment-heading"><h3>{hasComparison ? '版本比较' : '调整当前草稿'}</h3>
          {historyAvailable && <div className="photo-viewer-history" role="group" aria-label="调色历史">
            <button type="button" className="photo-viewer-button btn-ghost" disabled={!canUndo} onClick={() => { finishAdjustment(); onUndo?.() }}><ActionIcon name="undo" />撤销</button>
            <button type="button" className="photo-viewer-button btn-ghost" disabled={!canRedo} onClick={() => { finishAdjustment(); onRedo?.() }}><ActionIcon name="redo" />重做</button>
          </div>}
        </div>
        {hasComparison ? <div className="photo-viewer-edit-notice"><p>A / B 为固定版本快照。切换到当前草稿后，可在此继续调色。</p>
          {onEditDraft && <button type="button" className="photo-viewer-button btn-soft" onClick={() => { finishAdjustment(); onEditDraft() }}><ActionIcon name="adjust" />调整当前草稿</button>}
        </div> : !compatible ? <p className="photo-viewer-edit-notice">请确保照片与当前草稿的输入基准一致。可用撤销／重做恢复输入，或关闭查看器后确认照片输入，再调整参数。</p> : adjustmentPanel}
      </aside>}
      </div>
    </section>
  </ModalSurface>
}
