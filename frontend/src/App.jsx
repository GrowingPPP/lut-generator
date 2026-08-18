import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { generateLUT, defaultParams, applyLUTToImageData } from './lib/lutEngine.js'
import { LUTRenderer } from './lib/lutPreview.js'
import { listLuts, createLut, updateLut, deleteLut, downloadUrl, chatSession } from './lib/api.js'

let _testImage = null
function makeTestImage() {
  if (_testImage) return _testImage
  const c = document.createElement('canvas')
  c.width = 800
  c.height = 560
  const ctx = c.getContext('2d')
  const sky = ctx.createLinearGradient(0, 0, 0, 360)
  sky.addColorStop(0, '#3a4a63')
  sky.addColorStop(0.45, '#8a7a6a')
  sky.addColorStop(0.75, '#c89b72')
  sky.addColorStop(1, '#d9a878')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, 800, 360)
  ctx.fillStyle = '#f4d7a4'
  ctx.beginPath()
  ctx.arc(600, 270, 46, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#2e2b31'
  ctx.beginPath()
  ctx.moveTo(0, 360)
  ctx.lineTo(120, 240)
  ctx.lineTo(220, 330)
  ctx.lineTo(340, 210)
  ctx.lineTo(470, 350)
  ctx.lineTo(600, 250)
  ctx.lineTo(720, 340)
  ctx.lineTo(800, 300)
  ctx.lineTo(800, 360)
  ctx.closePath()
  ctx.fill()
  const sea = ctx.createLinearGradient(0, 360, 0, 560)
  sea.addColorStop(0, '#c8996f')
  sea.addColorStop(1, '#4a3a3c')
  ctx.fillStyle = sea
  ctx.fillRect(0, 360, 800, 200)
  _testImage = c
  return c
}

function makeThumb(params) {
  const w = 320
  const h = 200
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  ctx.drawImage(makeTestImage(), 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data, size } = generateLUT(params, 33)
  const out = applyLUTToImageData(imageData, data, size)
  ctx.putImageData(out, 0, 0)
  return c.toDataURL('image/jpeg', 0.85)
}

const SLIDERS = [
  { key: 'temp', label: '色温', min: -3000, max: 3000, step: 10, unit: 'K' },
  { key: 'tint', label: '色调', min: -500, max: 500, step: 5, unit: '' },
  { key: 'exposure', label: '曝光', min: -2, max: 2, step: 0.05, unit: ' EV' },
  { key: 'contrast', label: '对比度', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'saturation', label: '饱和度', min: -1, max: 1, step: 0.01, unit: '' },
  { key: 'hue', label: '色相', min: -180, max: 180, step: 1, unit: '°' },
  { key: 'vibrance', label: '自然饱和', min: -1, max: 1, step: 0.01, unit: '' },
]

const RGB_GROUPS = [
  { key: 'lift', label: '暗部', min: -0.1, max: 0.1, step: 0.005 },
  { key: 'gamma', label: '中间调', min: 0.5, max: 1.5, step: 0.005 },
  { key: 'gain', label: '亮部', min: 0.5, max: 1.5, step: 0.005 },
]

const RGB_CHANNELS = ['R', 'G', 'B']

const PHOTO_STYLES = [
  { value: 'STD', label: 'Standard' },
  { value: 'NAT', label: 'Natural' },
  { value: 'VIVD', label: 'Vivid' },
  { value: 'VLOG', label: 'V-Log' },
]

const PRESETS = [
  {
    name: '日系清透',
    params: { ...defaultParams(), base_photo_style: 'NAT', temp: 300, contrast: -0.15, saturation: -0.1 },
  },
  {
    name: '电影青橙',
    params: {
      ...defaultParams(),
      base_photo_style: 'VIVD',
      temp: -200,
      contrast: 0.15,
      lift: [0, 0.02, 0.05],
      gain: [1.1, 1, 0.9],
    },
  },
  {
    name: '复古胶片',
    params: {
      ...defaultParams(),
      base_photo_style: 'STD',
      temp: 400,
      contrast: 0.1,
      saturation: -0.2,
      vibrance: 0.1,
    },
  },
]

const DISPLAY_MODES = [
  { value: 'slider', label: '滑动对比' },
  { value: 'split', label: '独立展示' },
]

function usePreview(originalRef, gradedRef, params, displayMode) {
  const rendererRef = useRef(null)
  const imageRef = useRef(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const drawOriginal = useCallback(
    (img) => {
      const oc = originalRef.current
      if (!oc) return
      oc.width = img.width
      oc.height = img.height
      oc.getContext('2d').drawImage(img, 0, 0)
    },
    [originalRef],
  )

  // 初始化默认样张(仅一次)
  useEffect(() => {
    imageRef.current = makeTestImage()
  }, [])

  // 重建 renderer:挂载 + 展示形式切换(canvas 会重挂载)
  useEffect(() => {
    const img = imageRef.current
    const canvas = gradedRef.current
    if (!img || !canvas) return
    const renderer = new LUTRenderer(canvas)
    renderer.setImage(img)
    renderer.setSplitMode(displayMode === 'slider')
    const { data, size } = generateLUT(paramsRef.current, 33)
    renderer.setLUT(data, size)
    renderer.render()
    rendererRef.current = renderer
    drawOriginal(img)
    return () => {
      renderer.dispose()
      rendererRef.current = null
    }
  }, [displayMode, gradedRef, drawOriginal])

  // 参数变化 → 重新生成 LUT(rAF 合并,拖滑杆同一帧只烘一次)
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const id = requestAnimationFrame(() => {
      const { data, size } = generateLUT(paramsRef.current, 33)
      renderer.setLUT(data, size)
      renderer.render()
    })
    return () => cancelAnimationFrame(id)
  }, [params])

  const setSplit = useCallback((x) => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.setSplit(x)
    renderer.render()
  }, [])

  const upload = useCallback(
    (file) =>
      new Promise((resolve) => {
        const url = URL.createObjectURL(file)
        const img = new Image()
        img.onload = () => {
          imageRef.current = img
          drawOriginal(img)
          const renderer = rendererRef.current
          renderer.setImage(img)
          const { data, size } = generateLUT(paramsRef.current, 33)
          renderer.setLUT(data, size)
          renderer.render()
          URL.revokeObjectURL(url)
          resolve(true)
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          resolve(false)
        }
        img.src = url
      }),
    [drawOriginal],
  )

  return { setSplit, upload }
}

function GenerateView({ previewLut }) {
  const [params, setParams] = useState(defaultParams())
  const [displayMode, setDisplayMode] = useState('slider')
  const [split, setSplitState] = useState(0.5)
  const [messages, setMessages] = useState([
    { role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [name, setName] = useState('')
  const [savedId, setSavedId] = useState(null)
  const [status, setStatus] = useState('')
  const originalRef = useRef(null)
  const gradedRef = useRef(null)
  const draggingRef = useRef(false)
  const fileInputRef = useRef(null)
  const { setSplit, upload } = usePreview(originalRef, gradedRef, params, displayMode)

  useEffect(() => {
    if (previewLut) {
      setParams(previewLut.params)
      setMessages((m) => [...m, { role: 'agent', text: `已载入「${previewLut.name}」,上传样张即可预览效果。` }])
    }
  }, [previewLut])

  const updateParam = (key, value) => setParams((p) => ({ ...p, [key]: value }))

  const updateChannel = (key, idx, value) =>
    setParams((p) => {
      const arr = [...p[key]]
      arr[idx] = value
      return { ...p, [key]: arr }
    })

  const updateSplit = (clientX) => {
    const rect = gradedRef.current.getBoundingClientRect()
    const x = (clientX - rect.left) / rect.width
    const clamped = Math.max(0.02, Math.min(0.98, x))
    setSplit(clamped)
    setSplitState(clamped)
  }

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    const history = messages.slice(-6).map((m) => `${m.role === 'user' ? '用户' : '助手'}:${m.text}`)
    setMessages((m) => [...m, { role: 'user', text }])
    setInput('')
    setSending(true)
    try {
      const resp = await chatSession(text, params, history)
      setMessages((m) => [...m, { role: 'agent', text: resp.reply }])
      if (resp.params) setParams(resp.params)
    } catch (e) {
      setMessages((m) => [...m, { role: 'agent', text: `生成失败:${e.message}` }])
    } finally {
      setSending(false)
    }
  }

  const applyPreset = (preset) => {
    setParams({ ...preset.params })
    setMessages((m) => [...m, { role: 'agent', text: `已应用「${preset.name}」,可在右侧微调或直接保存。` }])
  }

  const save = async () => {
    try {
      const n = name.trim() || '未命名 LUT'
      const created = await createLut(n, '', params)
      setSavedId(created.id)
      setStatus(`已保存:${n}`)
    } catch (e) {
      setStatus(`保存失败:${e.message}`)
    }
  }

  return (
    <div className="gen-layout">
      <section className="chat-panel">
        <div className="chat-messages">
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'msg msg-user' : 'msg msg-agent'}>
              {m.text}
            </div>
          ))}
          {sending && <div className="msg msg-agent">思考中…</div>}
        </div>
        <div className="preset-chips">
          {PRESETS.map((p) => (
            <button key={p.name} className="chip" onClick={() => applyPreset(p)}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="chat-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="描述你想要的风格…"
          />
          <button className="btn-primary" onClick={send} disabled={sending}>
            发送
          </button>
        </div>
      </section>

      <section className="right-col">
        <div className="preview-toolbar">
          <label className="mode-select">
            展示形式
            <select
              value={displayMode}
              onChange={(e) => setDisplayMode(e.target.value)}
            >
              {DISPLAY_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="upload-sm" onClick={() => fileInputRef.current?.click()}>
            上传样张
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files[0]
              if (!f) return
              const ok = await upload(f)
              if (!ok) setStatus('图片加载失败,请用 JPEG/PNG 格式')
            }}
          />
        </div>

        {displayMode === 'slider' ? (
          <div
            className="slider-wrap"
            onPointerDown={(e) => {
              draggingRef.current = true
              updateSplit(e.clientX)
            }}
            onPointerMove={(e) => draggingRef.current && updateSplit(e.clientX)}
            onPointerUp={() => (draggingRef.current = false)}
            onPointerLeave={() => (draggingRef.current = false)}
          >
            <canvas ref={gradedRef} className="pane-canvas" />
            <div className="slider-handle" style={{ left: `${split * 100}%` }} />
            <span className="tag tag-orig">原图</span>
            <span className="tag tag-lut">LUT</span>
          </div>
        ) : (
          <div className="previews">
            <div className="pane">
              <div className="pane-label">原图</div>
              <canvas ref={originalRef} className="pane-canvas" />
            </div>
            <div className="pane">
              <div className="pane-label">LUT 叠加</div>
              <canvas ref={gradedRef} className="pane-canvas" />
            </div>
          </div>
        )}

        <div className="controls">
          <label className="slider ps-select">
            <span>基准</span>
            <select
              value={params.base_photo_style}
              onChange={(e) => setParams((p) => ({ ...p, base_photo_style: e.target.value }))}
            >
              {PHOTO_STYLES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {SLIDERS.map((s) => (
            <label key={s.key} className="slider">
              <span>{s.label}</span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={params[s.key]}
                onChange={(e) => updateParam(s.key, Number(e.target.value))}
              />
              <em>
                {params[s.key]}
                {s.unit}
              </em>
            </label>
          ))}
          {params.base_photo_style === 'VLOG' && (
            <label className="slider">
              <span>高光映射</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={params.tone_map}
                onChange={(e) => updateParam('tone_map', Number(e.target.value))}
              />
              <em>{params.tone_map.toFixed(2)}</em>
            </label>
          )}
          {RGB_GROUPS.map((g) => (
            <div key={g.key} className="rgb-group">
              <span className="rgb-group-label">{g.label}</span>
              {RGB_CHANNELS.map((c, idx) => (
                <label key={c} className="slider rgb-slider">
                  <span>{c}</span>
                  <input
                    type="range"
                    min={g.min}
                    max={g.max}
                    step={g.step}
                    value={params[g.key][idx]}
                    onChange={(e) => updateChannel(g.key, idx, Number(e.target.value))}
                  />
                  <em>{params[g.key][idx].toFixed(2)}</em>
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className="actions">
          <input
            className="name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="LUT 名称"
          />
          <button className="btn-primary" onClick={save}>
            保存到我的 LUT
          </button>
          {savedId && (
            <>
              <a className="btn" href={downloadUrl(savedId, 'camera')}>
                下载机内版
              </a>
              <a className="btn" href={downloadUrl(savedId, 'software')}>
                下载后期版
              </a>
            </>
          )}
          <span className="status">{status}</span>
        </div>
      </section>
    </div>
  )
}

function LibraryView({ onPreview }) {
  const [luts, setLuts] = useState([])
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')

  const thumbs = useMemo(() => {
    const map = {}
    for (const lut of luts) {
      map[lut.id] = makeThumb(lut.params)
    }
    return map
  }, [luts])

  const load = useCallback(async () => {
    try {
      setLuts(await listLuts())
      setError('')
    } catch (e) {
      setError(`加载失败:${e.message}。请确认后端已启动(localhost:8000)。`)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const remove = async (id) => {
    await deleteLut(id)
    load()
  }

  const startEdit = (lut) => {
    setEditingId(lut.id)
    setEditName(lut.name)
  }

  const saveEdit = async (id) => {
    await updateLut(id, { name: editName.trim() || '未命名 LUT' })
    setEditingId(null)
    load()
  }

  return (
    <div className="content">
      <div className="lib-head">
        <h1>我的 LUT</h1>
        <span className="count">{luts.length} 个</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="lib-grid">
        {luts.map((lut) => (
          <div key={lut.id} className="lut-card">
            <div className="card-thumb" style={{ backgroundImage: `url(${thumbs[lut.id]})` }}>
              <span className="card-badge">{lut.params.base_photo_style}</span>
            </div>
            <div className="card-body">
              {editingId === lut.id ? (
                <div className="edit-row">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <button className="btn" onClick={() => saveEdit(lut.id)}>
                    保存
                  </button>
                  <button className="btn" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <h3>{lut.name}</h3>
              )}
              <p className="card-desc">{lut.description || '—'}</p>
              <div className="card-actions">
                <button className="btn-primary" onClick={() => onPreview(lut)}>
                  预览
                </button>
                <a className="btn" href={downloadUrl(lut.id, 'camera')}>
                  机内版
                </a>
                <a className="btn" href={downloadUrl(lut.id, 'software')}>
                  后期版
                </a>
                <button className="btn" onClick={() => startEdit(lut)}>
                  编辑
                </button>
                <button className="btn-danger" onClick={() => remove(lut.id)}>
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
        {luts.length === 0 && !error && (
          <div className="empty">还没有 LUT,去「生成」页创建一个。</div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [view, setView] = useState('generate')
  const [previewLut, setPreviewLut] = useState(null)

  const openPreview = (lut) => {
    setPreviewLut({ ...lut, params: { ...lut.params } })
    setView('generate')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">C</span>
          CHROMA
        </div>
        <nav className="nav">
          <button className={view === 'generate' ? 'active' : ''} onClick={() => setView('generate')}>
            生成
          </button>
          <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>
            我的 LUT
          </button>
        </nav>
      </header>
      {view === 'generate' ? (
        <GenerateView previewLut={previewLut} />
      ) : (
        <LibraryView onPreview={openPreview} />
      )}
    </div>
  )
}
