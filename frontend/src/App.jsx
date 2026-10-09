import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultParams, normalizeParams } from './lib/lutEngine.js'
import { makeThumb } from './lib/preview.js'
import usePreview from './hooks/usePreview.js'
import {
  createLut, chatSession,
  listSessions, createSession, deleteSession, updateSession, listMessages,
  getAutoReport, undoAutoGrade, saveTextFile, cameraFileName,
  logout as apiLogout, me,
} from './lib/api.js'
import { paramsToCube } from './lib/lutEngine.js'
import AutoRetouchBar from './components/AutoRetouchBar.jsx'
import AutoRetouchReport from './components/AutoRetouchReport.jsx'
import AuthView from './components/AuthView.jsx'
import LibraryView from './components/LibraryView.jsx'
import LandingView from './LandingView.jsx'
import './Landing.css'

const PARAM_GROUPS = [
  {
    id: 'basic', label: '单张校正', defaultOpen: true,
    sliders: [
      { key: 'temp', label: '冷暖偏移', min: -3000, max: 3000, step: 10, unit: '' },
      { key: 'tint', label: '绿/洋红', min: -500, max: 500, step: 5, unit: '' },
      { key: 'exposure', label: '曝光', min: -3, max: 3, step: 0.05, unit: ' EV' },
    ],
  },
  {
    id: 'look', label: '风格', defaultOpen: true,
    sliders: [
      { key: 'look_strength', label: '风格强度', min: 0, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'tone', label: '影调', defaultOpen: true,
    sliders: [
      { key: 'contrast', label: '对比度', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'contrast_pivot', label: '对比中心', min: 0.1, max: 0.9, step: 0.005, unit: '' },
      { key: 'highlights', label: '高光', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'shadows', label: '阴影', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'whites', label: '白部层次', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'blacks', label: '黑部层次', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'curve', label: 'S 曲线', min: -1, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'color', label: '色彩', defaultOpen: false,
    sliders: [
      { key: 'saturation', label: '饱和度', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'vibrance', label: '自然饱和', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'hue', label: '全局色相', min: -180, max: 180, step: 1, unit: '°' },
    ],
  },
  {
    id: 'selective', label: '局部色彩', defaultOpen: false,
    sliders: [
      { key: 'selective_hue_center', label: '目标色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'selective_hue_width', label: '色相范围', min: 1, max: 180, step: 1, unit: '°' },
      { key: 'selective_hue_shift', label: '目标色相偏移', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'selective_saturation', label: '目标色饱和', min: -1, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'split', label: '分离色调', defaultOpen: false,
    sliders: [
      { key: 'split_shadow_hue', label: '阴影色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_shadow_sat', label: '阴影强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_highlight_hue', label: '高光色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_highlight_sat', label: '高光强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_mid_hue', label: '中间调色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_mid_sat', label: '中间调强度', min: 0, max: 1, step: 0.01, unit: '' },
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
  { key: 'lift', label: 'RGB 偏移', min: -0.1, max: 0.1, step: 0.005 },
  { key: 'gamma', label: '中间调', min: 0.5, max: 1.5, step: 0.005 },
  { key: 'gain', label: 'RGB 增益', min: 0.5, max: 1.5, step: 0.005 },
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
  const defaults = defaultParams()
  const keys = g.id === 'rgb' ? RGB_GROUPS.map((r) => r.key) : g.sliders.map((sl) => sl.key)
  const changed = keys.filter((k) => {
    const v = params[k]
    if (Array.isArray(v)) return v.some((x, i) => Math.abs(x - defaults[k][i]) > 1e-9)
    return Math.abs(v - defaults[k]) > 1e-9
  })
  return changed.length ? `${changed.length} 项已调整` : ''
}

function GenerateView({ previewLut }) {
  const [params, setRawParams] = useState(defaultParams)
  const setParams = useCallback((next) => {
    setRawParams((prev) => normalizeParams(typeof next === 'function' ? next(prev) : next))
  }, [])
  const [displayMode, setDisplayMode] = useState('slider')
  const [split, setSplitState] = useState(0.5)
  const [messages, setMessages] = useState([
    { role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [name, setName] = useState('')
  const [savedId, setSavedId] = useState(null)
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
  const openRequestRef = useRef(0)
  const { setSplit, upload } = usePreview(originalRef, gradedRef, params, displayMode)

  useEffect(() => {
    listSessions().then(setSessions).catch(() => {})
  }, [])

  useEffect(() => {
    if (previewLut) {
      setParams(previewLut.params)
      setGradeResult(null)
      setUndoSnapshot(null)
      setMessages((m) => [...m, { role: 'agent', text: `已载入「${previewLut.name}」,上传样张即可预览效果。` }])
    }
  }, [previewLut])

  const newSession = async () => {
    if (sending || grading) return
    openRequestRef.current += 1
    try {
      const s = await createSession('新会话')
      setSessions((prev) => [s, ...prev])
      setSessionId(s.id)
      setMessages([{ role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' }])
      setParams(defaultParams())
      setSavedId(null)
      setGradeResult(null)
      setUndoSnapshot(null)
      setStatus('')
    } catch (e) {
      setStatus(`新建会话失败:${e.message}`)
    }
  }

  const openSession = async (id) => {
    if (sending || grading) return
    const requestId = ++openRequestRef.current
    try {
      const msgs = await listMessages(id)
      if (requestId !== openRequestRef.current) return
      setSessionId(id)
      setSavedId(null)
      setStatus('')
      setName('')
      setGradeResult(null)
      setUndoSnapshot(null)
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
          if (requestId !== openRequestRef.current) return
          const current = rep && rep.session_id === id ? rep : null
          setGradeResult(current)
          setUndoSnapshot(current?.before_params || null)
        } catch {
          setGradeResult(null)
          setUndoSnapshot(null)
        }
      }
    } catch (e) {
      setStatus(`加载会话失败:${e.message}`)
    }
  }

  const removeSession = async (id) => {
    if (sending || grading) return
    openRequestRef.current += 1
    if (!window.confirm('删除该会话及其聊天记录?')) return
    try {
      await deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (id === sessionId) {
        setSessionId(null)
        setMessages([{ role: 'agent', text: '描述你想要的风格,比如「日系清透」「电影青橙」,我来生成 LUT。' }])
        setParams(defaultParams())
        setSavedId(null)
        setGradeResult(null)
        setUndoSnapshot(null)
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

  const updateParam = (key, value) => {
    setGradeResult(null)
    setUndoSnapshot(null)
    setParams((p) => ({ ...p, [key]: value }))
  }

  const updateChannel = (key, idx, value) => {
    setGradeResult(null)
    setUndoSnapshot(null)
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
    if (!text || sending || grading) return
    const history = messages.slice(-6).map((m) => `${m.role === 'user' ? '用户' : '助手'}:${m.text}`)
    setMessages((m) => [...m, { role: 'user', text }])
    setInput('')
    setSending(true)
    try {
      const resp = await chatSession(text, params, history, sessionId)
      setMessages((m) => [...m, { role: 'agent', text: resp.reply }])
      if (resp.params) {
        setParams(resp.params)
        setGradeResult(null)
        setUndoSnapshot(null)
      }
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
    if (sending || grading) return
    setParams({ ...preset.params })
    setGradeResult(null)
    setUndoSnapshot(null)
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

  // 下载总是取当前参数；会话里更早生成的 cube 不能覆盖后来应用的预设或基准。
  const downloadCube = (mode) => {
    try {
      const n = name.trim() || '未命名 LUT'
      const text = paramsToCube(params, { title: n, mode })
      const signal = params.base_photo_style === 'VLOG' ? 'VLOG_to_Rec709' : `${params.base_photo_style}_sRGB`
      const filename = mode === 'camera' ? cameraFileName(n) : `${n}_${signal}.cube`
      saveTextFile(text, filename)
      setStatus(`已下载:${filename}`)
    } catch (e) {
      setStatus(`下载失败:${e.message}`)
    }
  }

  return (
    <div className="gen-layout">
      <section className="chat-panel">
        <div className="session-bar">
          <button className="btn" onClick={newSession} disabled={sending || grading}>＋ 新会话</button>
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
                    <button className="session-del" onClick={() => removeSession(s.id)} disabled={sending || grading} title="删除会话">×</button>
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
            <button key={p.name} className="chip" onClick={() => applyPreset(p)} disabled={sending || grading}>
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
          <button className="btn-primary" onClick={send} disabled={sending || grading}>
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
          <button type="button" className="upload-sm" onClick={() => fileInputRef.current?.click()} disabled={grading}>
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
              if (f.size > 32 * 1024 * 1024) {
                setStatus('图片过大，请压缩到 32MB 以内')
                e.target.value = ''
                return
              }
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

        <p className="text-muted">{params.base_photo_style === 'VLOG'
          ? '上传未经显示转换的 V-Log/V-Gamut 帧作预览；普通 JPEG 不代表 V-Log 输入信号。'
          : `上传与 ${params.base_photo_style} Photo Style 相同的相机直出 JPEG，预览与自动修图才有参考价值。`}</p>

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
            setSavedId(null)
            setUndoSnapshot(result.before_params)
            if (result.session_id) {
              openRequestRef.current += 1
              setSessionId(result.session_id)
              listSessions().then(setSessions).catch(() => {})
            }
          }}
        />

        {gradeResult && (
          <AutoRetouchReport
            result={gradeResult}
            beforeParams={undoSnapshot}
            onUndo={async () => {
              try {
                const restored = await undoAutoGrade()
                setParams(restored.params)
                setGradeResult(null)
                setUndoSnapshot(null)
                setStatus('已撤销到修图前')
              } catch (e) { setStatus(`撤销失败:${e.message}`) }
            }}
          />
        )}

        <fieldset className="param-groups" disabled={grading || sending} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <div className="controls">
            <label className="slider ps-select">
              <span>基准</span>
              <select
                value={params.base_photo_style}
                onChange={(e) => updateParam('base_photo_style', e.target.value)}
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
                <span>V-Log 显示映射</span>
                <input
                  type="range"
                  aria-label="V-Log 显示映射"
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
          <p className="text-muted">Standard、Natural、Vivid 使用相同的相对调色曲线，并依赖各自的原始 Photo Style；此处不会将三种风格校准成同一画面。冷暖是以 6500K 为参考的相对 RGB 偏移，不代表拍摄色温。风格强度为 0 时仍保留输入转换、曝光和白平衡。RGB 偏移和增益影响全部亮度，只是在暗部或亮部更明显。</p>

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
                                aria-label={`${rg.label} ${c}`}
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
                            aria-label={sl.label}
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
        </fieldset>

        <div className="actions">
          <input
            className="name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="LUT 名称"
          />
          <button className="btn-primary" onClick={save} disabled={grading || sending}>
            保存到我的 LUT
          </button>
          <button className="btn" onClick={() => downloadCube('camera')} disabled={grading || sending}>直接下载机内版</button>
          <button className="btn" onClick={() => downloadCube('software')} disabled={grading || sending}>直接下载后期版</button>
          <span className="text-muted">机内版须与相机的 Photo Style「{params.base_photo_style}」匹配；文件名为 8 位字母数字。后期版仅省略机内标签，输入仍须为{params.base_photo_style === 'VLOG' ? ' V-Log/V-Gamut，输出 Rec.709' : ` ${params.base_photo_style} 照片信号，输出 sRGB`}。单张样张自动修正的曝光和白平衡仅适合相近光线。旧预设重新导出前请预览影调。</span>
          <span className="status">{status}</span>
        </div>
      </section>
    </div>
  )
}

export default function App() {
  // 落地页是入口:未登录访客先看到它,点 CTA 才进入生成的登录门。
  const [view, setView] = useState('landing')
  const [previewLut, setPreviewLut] = useState(null)
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener('chroma:unauthorized', onUnauthorized)
    return () => window.removeEventListener('chroma:unauthorized', onUnauthorized)
  }, [])

  useEffect(() => {
    // me() 未登录时返回 null(不是抛错)—— 见 lib/api.js 的说明
    me().then((u) => setUser(u ? u.username : null)).catch(() => setUser(null)).finally(() => setChecking(false))
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

  if (view === 'landing' && !user) return <LandingView onEnter={() => setView('generate')} />

  if (!user) {
    return <AuthView onAuthed={(u) => setUser(u)} />
  }

  return (
    <>
    {view === 'landing' && <LandingView onEnter={() => setView('generate')} />}
    <div className="app" style={{ display: view === 'landing' ? 'none' : undefined }}>
      {view !== 'landing' && <header className="topbar">
        <div className="brand">
          <span className="logo">C</span>
          CHROMA
        </div>
        <nav className="nav">
          {/* 首页是入口,排在两个子页之前;用一条分隔线与应用内导航区分开 */}
          <button className="nav-home" onClick={() => setView('landing')}>首页</button>
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
      </header>}
      <div style={{ display: view === 'generate' ? undefined : 'none' }}><GenerateView previewLut={previewLut} /></div>
      {view === 'library' && <LibraryView onPreview={openPreview} />}
    </div>
    </>
  )
}
