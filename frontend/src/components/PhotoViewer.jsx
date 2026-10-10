import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import useModalFocus from '../hooks/useModalFocus.js'
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
  const signature = JSON.stringify(params)
  const snapshot = useMemo(() => JSON.parse(signature), [signature])
  useEffect(() => {
    const canvas = ref.current
    let renderer, cancelled = false
    const status = state => onStatus({ ...state, image, signature })
    status({ loading: true, error: '' })
    const render = async () => {
      try {
        renderer = new LUTRenderer(canvas)
        const gl = renderer.gl
        const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
        const limit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...viewport)
        if (Math.max(image.width, image.height) > limit)
          throw new Error(`照片尺寸超过当前设备的 GPU 上限 ${limit}px，保留原图。请使用当前预览分辨率。`)
        await preloadExternalLut(snapshot.external_lut_id)
        if (cancelled) return
        const lut = generateLUT(snapshot, 33)
        renderer.setImage(image)
        renderer.setLUT(lut.data, lut.size)
        renderer.setSplitMode(false)
        renderer.setDisplayEncoding(snapshot.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB')
        renderer.render()
        if (gl.getError() !== gl.NO_ERROR) throw new Error('设备无法渲染此尺寸的照片，已保留原图。请使用当前预览分辨率。')
        if (!cancelled) status({ loading: false, error: '' })
      } catch (error) {
        if (!cancelled) {
          renderer?.clear(); renderer?.dispose()
          canvas.width = 1; canvas.height = 1
          status({ loading: false, error: error.message || '效果载入失败，已保留原图' })
        }
      }
    }
    render()
    return () => { cancelled = true; renderer?.dispose(); canvas.width = 1; canvas.height = 1 }
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

export default function PhotoViewer({ sample, media, params, compatible, comparison, onClose, initialMode = 'slider', initialSplit = 0.5 }) {
  const id = useId()
  const modalRef = useModalFocus(onClose)
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
  const [aState, setAState] = useState({ loading: hasComparison && compatible, error: '' })
  const [bState, setBState] = useState({ loading: compatible, error: '' })
  const stageRef = useRef(null)
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
  const fallback = !compatible || !!renderError || renderLoading
  const visibleMode = fallback ? 'original' : mode
  const photoSize = { width: image?.width || 1, height: image?.height || 1 }
  const transform = photoTransform(view, photoSize, frame)
  const sourceWidth = sample?.source_width || sample?.photo_metadata?.source_width
  const sourceHeight = sample?.source_height || sample?.photo_metadata?.source_height

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

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
    const stage = stageRef.current
    const measure = () => {
      const rect = stage.getBoundingClientRect()
      setFrame({ width: Math.max(1, visibleMode === 'side-by-side' ? (rect.width - 1) / 2 : rect.width), height: Math.max(1, rect.height) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [visibleMode])

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
    const stage = stageRef.current
    stage.addEventListener('wheel', wheel, { passive: false })
    return () => stage.removeEventListener('wheel', wheel)
  })

  const key = event => {
    if (event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return
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
  const modes = [['slider', '滑动对比'], ['side-by-side', '并排'], ['original', hasComparison && !fallback ? '仅 A' : '仅原图'], ['effect', hasComparison ? '仅 B' : '仅效果']]

  return <div className="photo-viewer-backdrop">
    <section ref={modalRef} className="photo-viewer" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} onKeyDown={key}>
      <header className="photo-viewer-header">
        <div className="photo-viewer-title"><h2 id={`${id}-title`}>放大查看</h2><span title={sample?.name}>{sample?.name || '调色示意图'}</span></div>
        <button type="button" className="photo-viewer-button photo-viewer-close" onClick={onClose}>关闭 <span aria-hidden="true">×</span></button>
      </header>
      <div className="photo-viewer-tools">
        <div className="photo-viewer-modes" role="group" aria-label="照片查看模式">{modes.map(([value, label]) => <button type="button" key={value} className="photo-viewer-button" aria-pressed={visibleMode === value} disabled={(!compatible || !!renderError) && value !== 'original'} onClick={() => setMode(value)}>{label}</button>)}</div>
        <div className="photo-viewer-zoom" role="group" aria-label="照片缩放">
          <button type="button" className="photo-viewer-button" onClick={fit}>适应窗口</button>
          <button type="button" className="photo-viewer-button" disabled={sourceLoading} onClick={() => loadOriginal(true)}>{file ? '1:1 像素' : sample ? '预览 1:1' : '示意图 1:1'}</button>
          <button type="button" className="photo-viewer-button photo-viewer-step" aria-label="缩小照片" onClick={() => zoom(view.scale / 1.25)} disabled={view.scale <= 0.25}>−</button>
          <label className="photo-viewer-scale"><span className="photo-viewer-sr-only">缩放比例</span><select aria-label="照片缩放比例" value={String(percent)} onChange={event => zoom(Number(event.target.value) / 100)}>
            {![25, 50, 75, 100, 150, 200, 300, 400].includes(percent) && <option value={percent}>{percent}%</option>}
            {[25, 50, 75, 100, 150, 200, 300, 400].map(value => <option value={value} key={value}>{value}%</option>)}
          </select></label>
          <button type="button" className="photo-viewer-button photo-viewer-step" aria-label="放大照片" onClick={() => zoom(view.scale * 1.25)} disabled={view.scale >= 4}>+</button>
        </div>
      </div>
      <div className="photo-viewer-status" aria-live="polite">
        <span>{resolution} · {image?.width} × {image?.height}px · {percent}%{view.fit ? ' · 适应窗口' : ''}</span>
        {file && !original && <button type="button" className="photo-viewer-button" disabled={sourceLoading} onClick={() => loadOriginal(false)}>{sourceLoading ? '正在载入原分辨率…' : '载入原分辨率'}</button>}
        {original && <button type="button" className="photo-viewer-button" onClick={previewAgain}>使用预览分辨率</button>}
        {sourceWidth && sourceHeight && !original && <span className="photo-viewer-source-size">原照片 {sourceWidth} × {sourceHeight}px</span>}
      </div>
      {!compatible && <p className="photo-viewer-notice">输入尚未确认或与当前参数不兼容，当前仅显示原图。请关闭查看器后确认照片输入基准。</p>}
      {sourceError && <p className="photo-viewer-error" role="alert">{sourceError}</p>}
      {renderError && <p className="photo-viewer-error" role="alert">效果载入失败：{renderError} 当前显示原图。</p>}
      {renderLoading && <p className="photo-viewer-notice" role="status">正在载入完整效果，暂时显示原图…</p>}
      <div ref={stageRef} className={`photo-viewer-stage photo-viewer-${visibleMode}${dragging ? ' is-dragging' : ''}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={() => { drag.current = null; setDragging(false) }}>
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
        {compatible && visibleMode === 'slider' && <div className="photo-viewer-split"><label htmlFor={`${id}-split`}>{aLabel} / {bLabel}</label><input id={`${id}-split`} type="range" min="0" max="100" value={Math.round(split * 100)} onChange={event => setSplit(Number(event.target.value) / 100)} aria-label="照片对比分界" aria-valuetext={`左侧 ${Math.round(split * 100)}%，右侧 ${Math.round((1 - split) * 100)}%`} /></div>}
        <p id={`${id}-help`}>滚轮缩放 · 拖动平移 · + / − 缩放 · 0 适应 · 1 {file ? '原像素' : '预览像素'} · 方向键平移 · Esc 关闭</p>
      </footer>
    </section>
  </div>
}
