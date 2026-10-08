import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultParams } from './lib/lutEngine.js'
import { makeThumb } from './lib/preview.js'
import usePreview from './hooks/usePreview.js'
import {
  createLut, chatSession,
  listSessions, createSession, deleteSession, updateSession, listMessages,
  getGeneratedLut, getAutoReport, saveTextFile,
  logout as apiLogout, me,
} from './lib/api.js'
import { paramsToCube } from './lib/lutEngine.js'
import AutoRetouchBar from './components/AutoRetouchBar.jsx'
import AutoRetouchReport from './components/AutoRetouchReport.jsx'
import AuthView from './components/AuthView.jsx'
import LibraryView from './components/LibraryView.jsx'

const PARAM_GROUPS = [
  {
    id: 'basic', label: '基础', defaultOpen: true,
    sliders: [
      { key: 'temp', label: '色温', min: -3000, max: 3000, step: 10, unit: 'K' },
      { key: 'tint', label: '色调', min: -500, max: 500, step: 5, unit: '' },
      { key: 'exposure', label: '曝光', min: -2, max: 2, step: 0.05, unit: ' EV' },
    ],
  },
  {
    id: 'tone', label: '影调', defaultOpen: true,
    sliders: [
      { key: 'contrast', label: '对比度', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'highlights', label: '高光', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'shadows', label: '阴影', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'whites', label: '白场', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'blacks', label: '黑场', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'curve', label: 'S 曲线', min: -1, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'color', label: '色彩', defaultOpen: false,
    sliders: [
      { key: 'saturation', label: '饱和度', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'vibrance', label: '自然饱和', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'hue', label: '色相', min: -180, max: 180, step: 1, unit: '°' },
    ],
  },
  {
    id: 'split', label: '分离色调', defaultOpen: false,
    sliders: [
      { key: 'split_shadow_hue', label: '阴影色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_shadow_sat', label: '阴影强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_highlight_hue', label: '高光色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_highlight_sat', label: '高光强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_balance', label: '平衡', min: 0, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'rgb', label: '分通道(RGB)', defaultOpen: false,
    sliders: [],
  },
]

// 折叠状态(组 id → 是否展开)
function defaultGroupOpen() {
  const o = {}
  for (const g of PARAM_GROUPS) o[g.id] = g.defaultOpen
  return o
}

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

function groupSummary(g, params) {
  const keys = g.id === 'rgb' ? RGB_GROUPS.map((r) => r.key) : g.sliders.map((sl) => sl.key)
  const changed = keys.filter((k) => {
    const v = params[k]
    if (Array.isArray(v)) return v.some((x, i) => x !== (k === 'gamma' || k === 'gain' ? 1 : 0))
    return Math.abs(v) > 1e-9
  })
  return changed.length ? `${changed.length} 项已调整` : ''
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
  // 服务端生成的 cube 文本(权威结果);参数被手动调整后置空并由前端本地重算
  const [cubeText, setCubeText] = useState(null)
  const [groupOpen, setGroupOpen] = useState(defaultGroupOpen)
  // 自动修图:原图文件(用于提交给后端)、运行状态、结果、撤销快照
  const [photoFile, setPhotoFile] = useState(null)
  const [grading, setGrading] = useState(false)
  const [gradeResult, setGradeResult] = useState(null)
  const [undoSnapshot, setUndoSnapshot] = useState(null)
  const [status, setStatus] = useState('')
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [editingSessionId, setEditingSessionId] = useState(null)
  const [editingTitle, setEditingTitle] = useState('')
  const originalRef = useRef(null)
  const gradedRef = useRef(null)
  const draggingRef = useRef(false)
  const fileInputRef = useRef(null)
  const { setSplit, upload } = usePreview(originalRef, gradedRef, params, displayMode)

  useEffect(() => {
    listSessions().then(setSessions).catch(() => {})
  }, [])

  useEffect(() => {
    if (previewLut) {
      setParams(previewLut.params)
      setMessages((m) => [...m, { role: 'agent', text: `已载入「${previewLut.name}」,上传样张即可预览效果。` }])
    }
  }, [previewLut])

  const newSession = async () => {
    try {
      const s = await createSession('新会话')
      setSessions((prev) => [s, ...prev])
      setSessionId(s.id)
      setMessages([{ role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' }])
      setParams(defaultParams())
      setSavedId(null)
      setCubeText(null)
      setStatus('')
    } catch (e) {
      setStatus(`新建会话失败:${e.message}`)
    }
  }

  const openSession = async (id) => {
    try {
      const msgs = await listMessages(id)
      setSessionId(id)
      setSavedId(null)
      setStatus('')
      setName('')
      setCubeText(null)
      if (msgs.length === 0) {
        setMessages([{ role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' }])
        setParams(defaultParams())
      } else {
        setMessages(msgs.map((m) => ({ role: m.role, text: m.content })))
        const lastAgent = [...msgs].reverse().find((m) => m.role === 'agent' && m.params)
        setParams(lastAgent ? lastAgent.params : defaultParams())
        // 自动修图报告:属于本会话才展示(否则在别的会话里会弹出上一份报告)
        try {
          const rep = await getAutoReport()
          setGradeResult(rep && rep.session_id === id ? rep : null)
        } catch {
          setGradeResult(null)
        }
        // 生成结果单独取:只有生成过 LUT 的会话才有,取回后可直接下载
        try {
          const gen = await getGeneratedLut(id)
          if (gen.params) setParams(gen.params)
          setCubeText(gen.cube_text)
        } catch {
          // 404 = 该会话还没生成过 LUT,保持默认参数即可
        }
      }
    } catch (e) {
      setStatus(`加载会话失败:${e.message}`)
    }
  }

  const removeSession = async (id) => {
    if (!window.confirm('删除该会话及其聊天记录?')) return
    try {
      await deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (id === sessionId) {
        setSessionId(null)
        setMessages([{ role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' }])
        setParams(defaultParams())
        setSavedId(null)
        setCubeText(null)
        setStatus('')
        setName('')
      }
    } catch (e) {
      setStatus(`删除会话失败:${e.message}`)
    }
  }

  const startEditSession = (s) => {
    setEditingSessionId(s.id)
    setEditingTitle(s.title)
  }

  const saveEditSession = async (id) => {
    const title = editingTitle.trim() || '新会话'
    try {
      await updateSession(id, title)
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
      setEditingSessionId(null)
    } catch (e) {
      setStatus(`重命名失败:${e.message}`)
    }
  }

  // 手动改参数后,服务端那份 cube 文本已不对应当前参数 → 置空,下载时由前端本地重算。
  // 只在用户写入口清:服务端结果的 setParams 不走这里,不会被误清。
  const updateParam = (key, value) => {
    setCubeText(null)
    setParams((p) => ({ ...p, [key]: value }))
  }

  const updateChannel = (key, idx, value) => {
    setCubeText(null)
    setParams((p) => {
      const arr = [...p[key]]
      arr[idx] = value
      return { ...p, [key]: arr }
    })
  }

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
      const resp = await chatSession(text, params, history, sessionId)
      setMessages((m) => [...m, { role: 'agent', text: resp.reply }])
      if (resp.params) setParams(resp.params)
      // 后端本次生成了 LUT → 直接持有权威 cube 文本,可立即下载,无需先保存
      if (resp.done && resp.cube_text) setCubeText(resp.cube_text)
      if (resp.session_id && resp.session_id !== sessionId) {
        setSessionId(resp.session_id)
        setSessions((prev) => (prev.some((s) => s.id === resp.session_id) ? prev : [{ id: resp.session_id, title: '新会话', created_at: '' }, ...prev]))
        listSessions().then(setSessions).catch(() => {})
      }
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

  // 直接下载当前调色结果,无需先保存。
  // 服务端 cube 文本可用则复用(权威结果);参数被手动改过则按当前参数本地重算。
  // 服务端那份含 #LUMIXPHOTOSTYLE 头 → 后期版需剥掉;本地重算是按 mode 现场生成的。
  const downloadCube = (mode) => {
    try {
      const n = name.trim() || '未命名 LUT'
      let text = cubeText || paramsToCube(params, { title: n, mode })
      if (cubeText && mode === 'software') {
        text = text
          .split('\n')
          .filter((line) => !line.startsWith('#LUMIXPHOTOSTYLE'))
          .join('\n')
      }
      saveTextFile(text, `${n}_${mode}.cube`)
      setStatus(`已下载:${n}_${mode}.cube${cubeText ? '' : '(按当前参数本地生成)'}`)
    } catch (e) {
      setStatus(`下载失败:${e.message}`)
    }
  }

  return (
    <div className="gen-layout">
      <section className="chat-panel">
        <div className="session-bar">
          <button className="btn" onClick={newSession}>＋ 新会话</button>
          <div className="session-list">
            {sessions.map((s) => (
              <div key={s.id} className={s.id === sessionId ? 'session-item active' : 'session-item'}>
                {editingSessionId === s.id ? (
                  <input
                    className="session-edit"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => saveEditSession(s.id)}
                    onKeyDown={(e) => e.key === 'Enter' && saveEditSession(s.id)}
                    autoFocus
                  />
                ) : (
                  <>
                    <span className="session-title" onClick={() => openSession(s.id)} onDoubleClick={() => startEditSession(s)}>{s.title}</span>
                    <button className="session-del" onClick={() => removeSession(s.id)} title="删除会话">×</button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
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
              if (!ok) {
                setStatus('图片加载失败,请用 JPEG/PNG 格式')
              } else {
                setPhotoFile(f)          // 自动修图要用原始字节提交
                setGradeResult(null)
                setUndoSnapshot(null)
              }
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

        <AutoRetouchBar
          file={photoFile}
          params={params}
          hasRealPhoto={!!photoFile}
          running={grading}
          setRunning={setGrading}
          setStatus={setStatus}
          onBeforeRun={(snapshot) => setUndoSnapshot(snapshot)}
          onResult={(result) => {
            // 记住报告属于哪个会话(后端把它写进固定的「自动修图」会话)
            setGradeResult(result)
            setParams(result.params)
            setCubeText(null)        // 参数变了,服务端那份 cube 文本已失效
            setSavedId(null)
          }}
        />

        {gradeResult && (
          <AutoRetouchReport
            result={gradeResult}
            beforeParams={undoSnapshot}
            onUndo={() => {
              if (undoSnapshot) setParams(undoSnapshot)
              setGradeResult(null)
              setStatus('已撤销到修图前')
            }}
          />
        )}

        <div className="param-groups">
          <div className="controls">
            <label className="slider ps-select">
              <span>基准</span>
              <select
                value={params.base_photo_style}
                onChange={(e) => setParams((p) => ({ ...p, base_photo_style: e.target.value }))}
              >
                {PHOTO_STYLES.map((st) => (
                  <option key={st.value} value={st.value}>
                    {st.label}
                  </option>
                ))}
              </select>
            </label>
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
          </div>

          {PARAM_GROUPS.map((g) => (
            <section key={g.id} className="param-group">
              <button
                type="button"
                className="param-group-head"
                aria-expanded={groupOpen[g.id]}
                onClick={() => setGroupOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
              >
                <span className="param-group-arrow">{groupOpen[g.id] ? '▾' : '▸'}</span>
                <span className="param-group-label">{g.label}</span>
                {!groupOpen[g.id] && <span className="param-group-hint">{groupSummary(g, params)}</span>}
              </button>
              {groupOpen[g.id] && (
                <div className="controls">
                  {g.id === 'rgb'
                    ? RGB_GROUPS.map((rg) => (
                        <div key={rg.key} className="rgb-group">
                          <span className="rgb-group-label">{rg.label}</span>
                          {RGB_CHANNELS.map((c, idx) => (
                            <label key={c} className="slider rgb-slider">
                              <span>{c}</span>
                              <input
                                type="range"
                                min={rg.min}
                                max={rg.max}
                                step={rg.step}
                                value={params[rg.key][idx]}
                                onChange={(e) => updateChannel(rg.key, idx, Number(e.target.value))}
                              />
                              <em>{params[rg.key][idx].toFixed(2)}</em>
                            </label>
                          ))}
                        </div>
                      ))
                    : g.sliders.map((sl) => (
                        <label key={sl.key} className="slider">
                          <span>{sl.label}</span>
                          <input
                            type="range"
                            min={sl.min}
                            max={sl.max}
                            step={sl.step}
                            value={params[sl.key]}
                            onChange={(e) => updateParam(sl.key, Number(e.target.value))}
                          />
                          <em>
                            {Number(params[sl.key]).toFixed(2)}
                            {sl.unit}
                          </em>
                        </label>
                      ))}
                </div>
              )}
            </section>
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
          <button className="btn" onClick={() => downloadCube('camera')}>直接下载机内版</button>
          <button className="btn" onClick={() => downloadCube('software')}>直接下载后期版</button>
          {savedId && (
            <>
              <button className="btn" onClick={() => downloadAndSave(savedId, 'camera')}>已保存·机内版</button>
              <button className="btn" onClick={() => downloadAndSave(savedId, 'software')}>已保存·后期版</button>
            </>
          )}
          <span className="status">{status}</span>
        </div>
      </section>
    </div>
  )
}

export default function App() {
  const [view, setView] = useState('generate')
  const [previewLut, setPreviewLut] = useState(null)
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener('chroma:unauthorized', onUnauthorized)
    return () => window.removeEventListener('chroma:unauthorized', onUnauthorized)
  }, [])

  useEffect(() => {
    me().then((u) => setUser(u.username)).catch(() => setUser(null)).finally(() => setChecking(false))
  }, [])

  const openPreview = (lut) => {
    setPreviewLut({ ...lut, params: { ...lut.params } })
    setView('generate')
  }

  const handleLogout = async () => {
    try {
      await apiLogout()
    } catch {
      // 忽略退出失败,本地仍清登录态
    }
    setUser(null)
  }

  if (checking) return null

  if (!user) {
    return <AuthView onAuthed={(u) => setUser(u)} />
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
        <div className="topbar-user">
          <span>{user}</span>
          <button className="btn" onClick={handleLogout}>退出</button>
        </div>
      </header>
      {view === 'generate' ? (
        <GenerateView previewLut={previewLut} />
      ) : (
        <LibraryView onPreview={openPreview} />
      )}
    </div>
  )
}
