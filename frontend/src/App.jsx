import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultParams, normalizeParams } from './lib/lutEngine.js'
import usePreview from './hooks/usePreview.js'
import useWorkspace from './hooks/useWorkspace.js'
import useModalFocus from './hooks/useModalFocus.js'
import { inputContract, applyStyleRecipe } from './lib/styleRecipe.js'
import { lockConflicts } from './lib/workspace.js'
import { decodeSample, restoreSample, sampleMatches, sampleIsNormalized } from './lib/samples.js'
import { diffParams } from './lib/autoGrade.js'
import { parameterSignature, effectivePhases, versionSource, equivalentCandidate, contextSignature, reportIsHistorical } from './lib/workspaceFlow.js'
import WorkspaceToolbar from './components/WorkspaceToolbar.jsx'
import InputConfirmationDialog from './components/InputConfirmationDialog.jsx'
import SampleGallery from './components/SampleGallery.jsx'
import SampleInputPreview from './components/SampleInputPreview.jsx'
import VersionPanel from './components/VersionPanel.jsx'
import StyleSaveDialog from './components/StyleSaveDialog.jsx'
import CameraGuideDialog from './components/CameraGuideDialog.jsx'
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx'
import ComparisonPreview, { RenderedImage } from './components/ComparisonPreview.jsx'
import {
  createLut, chatSession,
  listSessions, createSession, deleteSession, updateSession, listMessages,
  saveTextFile, cameraFileName, listWorkspaces, createWorkspace, updateWorkspace, listVersions, createVersion, renameVersion, deleteVersion, applyLut, validateWorkspace, updateLut, getAutoReport,
  logout as apiLogout, me,
} from './lib/api.js'
import { paramsToCube } from './lib/lutEngine.js'
import { sameAutoMetadata } from './lib/autoJobs.js'
import { preloadExternalLut, clearExternalLutCache } from './lib/importedLuts.js'
import CurveEditor from './components/CurveEditor.jsx'
import ImportedLutPanel from './components/ImportedLutPanel.jsx'
import ReferenceMatchDialog from './components/ReferenceMatchDialog.jsx'
import PhotoExportDialog from './components/PhotoExportDialog.jsx'
import AutoRetouchBar from './components/AutoRetouchBar.jsx'
import AutoRetouchReport from './components/AutoRetouchReport.jsx'
import AuthView from './components/AuthView.jsx'
import LibraryView from './components/LibraryView.jsx'
import LandingView from './LandingView.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import './Landing.css'
import './GenerationWorkspace.css'

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

const TOOL_TABS = [['ai', 'AI 创作'], ['manual', '手动调整'], ['versions', '版本']]
const AI_INTENTS = [['optimize', '照片优化'], ['text', '文字微调'], ['reference', '参考匹配']]

function WorkbenchDialog({ title, onClose, children }) {
  const modal = useModalFocus(onClose)
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={modal} className="workspace-modal workspace-history-drawer" role="dialog" aria-modal="true" aria-labelledby="workspace-history-title">
      <div className="section-heading"><h2 id="workspace-history-title">{title}</h2><button className="btn" onClick={onClose}>关闭</button></div>
      {children}
    </section>
  </div>
}

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

function GenerateView({ previewLut, user }) {
  const editor = useWorkspace({ userId: user, initialParams: defaultParams() })
  const { workspace, ready } = editor
  const params = workspace.params
  const [displayMode, setDisplayMode] = useState('slider')
  const [split, setSplitState] = useState(0.5)
  const [messages, setMessages] = useState([
    { role: 'agent', text: '描述你想要的风格，目标与参数保护会同时用于本次调整。' },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [grading, setGrading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [sampleLoading, setSampleLoading] = useState(false)
  const [advancedLoading, setAdvancedLoading] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [groupOpen, setGroupOpen] = useState(defaultGroupOpen)
  const [sessions, setSessions] = useState([])
  const [remoteWorkspaces, setRemoteWorkspaces] = useState([])
  const [versions, setVersions] = useState([])
  const [comparison, setComparison] = useState(null)
  const [saveDialog, setSaveDialog] = useState(false)
  const [cameraGuide, setCameraGuide] = useState(null)
  const [inputConfirmation, setInputConfirmation] = useState(false)
  const [toolTab, setToolTab] = useState('ai')
  const [aiIntent, setAiIntent] = useState('optimize')
  const [curvesOpen, setCurvesOpen] = useState(false)
  const [workspaceHistory, setWorkspaceHistory] = useState(false)
  const [detailsRequest, setDetailsRequest] = useState(0)
  const [photoExport, setPhotoExport] = useState(false)
  const [resourceLoading, setResourceLoading] = useState(false)
  const [resourceError, setResourceError] = useState('')
  const [savedAsset, setSavedAsset] = useState(null)
  const [pendingAsset, setPendingAsset] = useState(null)
  const [baselineFields, setBaselineFields] = useState([])
  const [media, setMedia] = useState(new Map())
  const [selectedId, setSelectedId] = useState(null)
  const [rebindingId, setRebindingId] = useState(null)
  const originalRef = useRef(null)
  const gradedRef = useRef(null)
  const draggingRef = useRef(false)
  const fileInputRef = useRef(null)
  const openRequestRef = useRef(0)
  const remoteRequests = useRef(new Map())
  const consumedPreviewRef = useRef(null)
  const viewWorkspaceRef = useRef(null)
  const mediaRef = useRef(media)
  mediaRef.current = media
  const currentRef = useRef(workspace)
  currentRef.current = workspace
  const baseBusy = sending || grading || validating || sampleLoading || remoteBusy || resourceLoading || !ready
  const busy = baseBusy || advancedLoading
  const samples = workspace.samples || []
  const primaryId = workspace.primary_sample_id || null
  const selectedSample = samples.find((s) => s.id === selectedId) || samples[0]
  const primarySample = samples.find((s) => s.id === primaryId)
  const selectedMedia = media.get(selectedSample?.id)
  const primaryMedia = media.get(primaryId)
  const compatible = !!selectedSample?.input_confirmed && sampleMatches(selectedSample, params)
  const primaryCompatible = !!primarySample?.input_confirmed && sampleMatches(primarySample, params)
  const { setSplit, error: previewError } = usePreview(
    originalRef,
    gradedRef,
    params,
    displayMode,
    selectedMedia?.canvas,
    !samples.length || (!!selectedMedia && compatible),
  )
  const context = useMemo(() => ({ goal_mode: workspace.goal_mode, locked_fields: workspace.locked_fields }),
    [workspace.goal_mode, workspace.locked_fields])
  const retainPreviews = !!workspace.retain_previews
  const gradeResult = workspace.report
  const validation = workspace.validation
  const sampleKey = JSON.stringify(
    samples.map((s) => [
      s.id,
      s.source_digest,
      s.preview_digest,
      s.input_contract,
      s.input_confirmed,
      media.get(s.id)?.metadata.origin,
    ]),
  )
  const validationStale =
    validation?.stale ||
    validation?._params_json !== parameterSignature(params) ||
    validation?._samples_json !== sampleKey

  useEffect(() => {
    let cancelled = false
    setResourceError('')
    setResourceLoading(Boolean(params.external_lut_id))
    preloadExternalLut(params.external_lut_id).catch((error) => {
      if (!cancelled) setResourceError(error.message)
    }).finally(() => { if (!cancelled) setResourceLoading(false) })
    return () => { cancelled = true }
  }, [params.external_lut_id, workspace.id])

  const ensureRemote = async (ws = currentRef.current) => {
    if (remoteRequests.current.has(ws.id)) return remoteRequests.current.get(ws.id)
    const request = createWorkspace({
      id: ws.id,
      session_id: ws.session_id,
      name: ws.name || '调色工作区',
    })
      .then((record) => {
        setRemoteWorkspaces((prev) =>
          prev.some((v) => v.id === record.id) ? prev : [record, ...prev],
        )
        return record
      })
      .catch((e) => {
        remoteRequests.current.delete(ws.id)
        throw e
      })
    remoteRequests.current.set(ws.id, request)
    return request
  }

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setStatus(e.message))
    listWorkspaces()
      .then((items) => {
        setRemoteWorkspaces(items)
        items.forEach((item) => remoteRequests.current.set(item.id, Promise.resolve(item)))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setVersions([])
    const view = workspace.view_state || {}
    setDisplayMode(
      DISPLAY_MODES.some((mode) => mode.value === view.display_mode) ? view.display_mode : 'slider',
    )
    const restoredSplit = Number.isFinite(view.split)
      ? Math.max(0.02, Math.min(0.98, view.split))
      : 0.5
    setSplitState(restoredSplit)
    setSplit(restoredSplit)
    setComparison(view.comparison || null)
    setToolTab(TOOL_TABS.some(([key]) => key === view.tool_tab) ? view.tool_tab : 'ai')
    setAiIntent(AI_INTENTS.some(([key]) => key === view.ai_intent) ? view.ai_intent : 'optimize')
    setCurvesOpen(Boolean(view.curves_open))
    setSavedAsset(null)
    setBaselineFields([])
    ensureRemote(workspace)
      .then(() => listVersions(workspace.id))
      .then((v) => {
        if (!cancelled) setVersions(v)
      })
      .catch((e) => {
        if (!cancelled) setStatus(`工作区同步失败：${e.message}`)
      })
    if (!workspace.report) {
      ensureRemote(workspace)
        .then(() => getAutoReport(workspace.id))
        .then((report) => {
          if (!cancelled && report && !currentRef.current.report)
            editor.setMeta({
              report: {
                ...report,
                _params_json: parameterSignature(report.params),
                _sample_id: report.main_sample_id,
                _source_digest: report.source_digest,
              },
            })
        })
        .catch(() => {})
    }
    if (workspace.session_id)
      listMessages(workspace.session_id)
        .then((v) => {
          if (!cancelled)
            setMessages(
              v.length
                ? v.map((m) => ({ role: m.role, text: m.content }))
                : [{ role: 'agent', text: '可以继续描述风格或调整参数。' }],
            )
        })
        .catch(() => {})
    else
      setMessages([{ role: 'agent', text: '描述你想要的风格，目标与参数保护会同时用于本次调整。' }])
    setSelectedId(
      workspace.samples?.some((sample) => sample.id === view.selected_sample_id)
        ? view.selected_sample_id
        : workspace.primary_sample_id || workspace.samples?.[0]?.id || null,
    )
    const restore = async () => {
      const restored = new Map()
      for (const sample of workspace.samples || []) {
        const current = mediaRef.current.get(sample.id)
        if (current) restored.set(sample.id, current)
        else if (workspace.retain_previews) {
          const cached = await editor.getCachedPreview(sample.id)
          const blob = cached?.blob || cached
          if (blob instanceof Blob) {
            try {
              restored.set(sample.id, await restoreSample(blob, sample))
            } catch {
              /* A missing preview leaves the sample available for rebinding. */
            }
          }
        }
      }
      if (!cancelled) setMedia(restored)
    }
    restore()
    return () => {
      cancelled = true
    }
  }, [ready, workspace.id])

  useEffect(() => {
    if (!ready) return
    if (viewWorkspaceRef.current !== workspace.id) {
      viewWorkspaceRef.current = workspace.id
      return
    }
    const view = { display_mode: displayMode, split, selected_sample_id: selectedId, comparison,
      tool_tab: toolTab, ai_intent: aiIntent, curves_open: curvesOpen }
    if (JSON.stringify(view) !== JSON.stringify(workspace.view_state))
      editor.setMeta({ view_state: view })
  }, [ready, workspace.id, displayMode, split, selectedId, comparison, toolTab, aiIntent, curvesOpen, editor.setMeta])

  useEffect(() => {
    if (!previewLut || busy || consumedPreviewRef.current === previewLut) return
    consumedPreviewRef.current = previewLut
    prepareAsset(previewLut)
  }, [previewLut, busy])

  useEffect(() => {
    const onKey = (e) => {
      if (
        !(e.ctrlKey || e.metaKey) ||
        e.key.toLowerCase() !== 'z' ||
        busy ||
        saveDialog ||
        inputConfirmation ||
        pendingAsset ||
        workspaceHistory ||
        photoExport ||
        /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)
      )
        return
      e.preventDefault()
      if (e.shiftKey && editor.canRedo) {
        editor.redo()
        setStatus('已重做上一项调整')
      } else if (!e.shiftKey && editor.canUndo) {
        editor.undo()
        setStatus('已撤销上一项调整')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor.undo, editor.redo, editor.canUndo, editor.canRedo, busy, saveDialog, inputConfirmation, pendingAsset, workspaceHistory, photoExport])

  const captureRequest = () => {
    const ws = currentRef.current
    return {
      workspace_id: ws.id,
      params_json: parameterSignature(ws.params),
      context_json: JSON.stringify({ goal_mode: ws.goal_mode, locked_fields: ws.locked_fields }),
      primary_id: ws.primary_sample_id || null,
      source_digest:
        (ws.samples || []).find((s) => s.id === ws.primary_sample_id)?.source_digest || null,
    }
  }
  const requestMatches = (request) => JSON.stringify(captureRequest()) === JSON.stringify(request)
  const applyAutoResult = async (result, meta, request = null) => {
    const ws = currentRef.current
    const sample = (ws.samples || []).find((item) => item.id === ws.primary_sample_id)
    const current = { workspace_id: ws.id, params: ws.params,
      context: { goal_mode: ws.goal_mode, locked_fields: ws.locked_fields },
      main_sample_id: ws.primary_sample_id, source_digest: sample?.source_digest }
    if ((request && !requestMatches(request)) || !sameAutoMetadata(meta?.requestSummary, current)
      || parameterSignature(result.before_params) !== parameterSignature(ws.params)
      || result.workspace_id !== ws.id || result.source_digest !== sample?.source_digest
      || result.main_sample_id !== ws.primary_sample_id || result.job_id !== meta?.jobId) {
      setStatus('工作区、参数或主样张已变化，本次响应未应用')
      return false
    }
    if ((ws.applied_auto_job_ids || []).includes(meta.jobId)) return true
    await preloadExternalLut(result.params.external_lut_id)
    const latest = currentRef.current
    const latestSample = latest.samples.find(item => item.id === latest.primary_sample_id)
    if (!sameAutoMetadata(meta.requestSummary, { workspace_id: latest.id, params: latest.params,
      context: { goal_mode: latest.goal_mode, locked_fields: latest.locked_fields },
      main_sample_id: latest.primary_sample_id, source_digest: latestSample?.source_digest })) return false
    const report = { ...result, job_id: meta.jobId,
      _params_json: parameterSignature(result.params), _sample_id: ws.primary_sample_id,
      _source_digest: sample?.source_digest, _sample_name: sample?.name,
      _request_context: structuredClone(meta.requestSummary.context),
      _context_json: contextSignature(meta.requestSummary.context), _applied_at: new Date().toISOString() }
    const next = editor.commit(result.params, { id: meta.jobId, source: 'auto', purpose: 'correction',
      phases: effectivePhases(result), report })
    if (!next) { setStatus('参数未应用，请查看草稿提示'); return false }
    await editor.setMeta({ report: next.report?.job_id === meta.jobId ? next.report : report,
      applied_auto_job_ids: [...(ws.applied_auto_job_ids || []), meta.jobId].slice(-200),
      ...(result.session_id ? { session_id: result.session_id } : {}) })
    if (!(await editor.flush())) { setStatus('本次结果未能保存，恢复记录保留，请重试草稿保存'); return false }
    if (result.session_id) listSessions().then(setSessions).catch(() => {})
    return true
  }


  const newWorkspace = async () => {
    if (busy) return
    setRemoteBusy(true)
    try {
      if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      const session = await createSession('新会话')
      const id = crypto.randomUUID()
      const loaded = await editor.loadWorkspace({
        id,
        params: defaultParams(),
        legacy: false,
        sessionId: session.id,
        name: '',
      })
      if (!loaded) throw new Error('未能创建新草稿，请查看本机保存提示')
      setSessions((prev) => [session, ...prev])
      setStatus('已创建新工作区')
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }

  const openWorkspace = async (id) => {
    if (busy || id === workspace.id) return
    setRemoteBusy(true)
    const record = remoteWorkspaces.find((w) => w.id === id)
    const request = ++openRequestRef.current
    try {
      if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      const msgs = record?.session_id ? await listMessages(record.session_id) : []
      if (request !== openRequestRef.current) return
      const last = [...msgs].reverse().find((m) => m.role === 'agent' && m.params)
      const loaded = await editor.loadWorkspace({
        id,
        params: last?.params || defaultParams(),
        legacy: true,
        sessionId: record?.session_id,
        name: record?.name || '',
      })
      if (!loaded) throw new Error('草稿未能载入，请查看本机保存提示')
      setStatus('已载入工作区；本机草稿优先恢复')
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }

  const openSession = async (id) => {
    if (busy) return
    const linked = remoteWorkspaces.find((w) => w.session_id === id)
    if (linked) return openWorkspace(linked.id)
    setRemoteBusy(true)
    const request = ++openRequestRef.current
    try {
      if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      const msgs = await listMessages(id)
      if (request !== openRequestRef.current) return
      const last = [...msgs].reverse().find((m) => m.role === 'agent' && m.params)
      const loaded = await editor.loadWorkspace({
        id: crypto.randomUUID(),
        params: last?.params || defaultParams(),
        legacy: true,
        sessionId: id,
        name: sessions.find((s) => s.id === id)?.title || '',
      })
      if (!loaded) throw new Error('会话草稿未能载入，请查看本机保存提示')
      setStatus('旧会话已转为工作区，保存可复用风格前需确认旧参数来源')
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }

  const removeSession = async (id) => {
    if (busy || !window.confirm('删除此会话及聊天记录？关联工作区、版本与风格资产将保留。')) return
    setRemoteBusy(true)
    try {
      await deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setRemoteWorkspaces((prev) =>
        prev.map((w) => (w.session_id === id ? { ...w, session_id: null } : w)),
      )
      if (workspace.session_id === id) await editor.setMeta({ session_id: null })
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }

  const toggleLock = (fields) => {
    const locked = workspace.locked_fields
    const all = fields.every((k) => locked.includes(k))
    editor.setLocks(
      all ? locked.filter((k) => !fields.includes(k)) : [...new Set([...locked, ...fields])],
    )
  }
  const locked = (key) => workspace.locked_fields.includes(key)
  const labelFor = (key) =>
    PARAM_GROUPS.flatMap((g) => g.sliders).find((s) => s.key === key)?.label ||
    RGB_GROUPS.find((g) => g.key === key)?.label ||
    { base_photo_style: '输入基准', tone_map: '显示映射' }[key] ||
    key
  const lockButton = (key) => (
    <button
      type="button"
      className={`parameter-lock ${locked(key) ? 'locked' : ''}`}
      aria-label={`${locked(key) ? '解锁' : '保护'}${labelFor(key)}`}
      title={locked(key) ? '解除参数保护' : '保护参数'}
      onClick={() => toggleLock([key])}
    >
      {locked(key) ? '已保护' : '保护'}
    </button>
  )
  const gesture = {
    onPointerDown: () => editor.begin({ source: 'manual' }),
    onPointerUp: () => editor.commit(),
    onPointerCancel: () => editor.commit(),
    onKeyDown: (e) => {
      if (
        [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(e.key)
      )
        editor.begin({ source: 'manual' })
    },
    onKeyUp: () => editor.commit(),
    onBlur: () => editor.commit(),
  }
  const updateParam = (key, value) => editor.update({ [key]: value })
  const updateChannel = (key, idx, value) =>
    editor.update((p) => ({ ...p, [key]: p[key].map((v, i) => (i === idx ? value : v)) }))

  const confirmConflicts = (candidate) => {
    const fields = lockConflicts(params, candidate, workspace.locked_fields)
    if (!fields.length) return []
    return window.confirm(
      `以下受保护项与候选冲突：${fields.map(labelFor).join('、')}。解除这些项的保护并完整应用？`,
    )
      ? fields
      : null
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setSending(true)
    setStatus('正在根据文字提取调整项…')
    const request = captureRequest()
    const history = messages
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}:${m.text}`)
    setMessages((m) => [...m, { role: 'user', text }])
    setInput('')
    try {
      await ensureRemote()
      const resp = await chatSession(text, params, history, workspace.session_id, {
        workspace_id: workspace.id,
        context,
        source_digest: request.source_digest,
        main_sample_id: request.primary_id,
      })
      if (!requestMatches(request)) {
        setStatus('工作区已变化，本次响应未应用')
        return
      }
      setMessages((m) => [...m, { role: 'agent', text: resp.reply }])
      if (resp.params) {
        const next = editor.commit(resp.params, {
          source: 'chat',
          purpose: workspace.purpose,
          phases: resp.steps
            ? effectivePhases(resp, { chatPurpose: workspace.purpose })
            : undefined,
        })
        setStatus(next ? (diffParams(params, next.params).length ? '文字调整已更新当前效果，可撤销；对话中的生成确认请按回复操作' : '本次没有改变参数，请查看回复') : '本次文字调整未应用，请查看草稿提示')
      } else setStatus('已收到回复，当前参数未改变；请查看回复中的下一步')
      if (resp.session_id) {
        await editor.setMeta({ session_id: resp.session_id })
        await updateWorkspace(workspace.id, { session_id: resp.session_id })
        listSessions()
          .then(setSessions)
          .catch(() => {})
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'agent', text: `生成失败：${e.message}` }])
      setStatus(`文字调整未完成：${e.message}`)
    } finally {
      setSending(false)
    }
  }

  const applyPreset = (preset) => {
    if (busy) return
    const unlockFields = confirmConflicts(preset.params)
    if (unlockFields === null) return
    editor.commit(preset.params, { source: 'preset', unlockFields, replaceBaseline: true })
    setStatus(`已载入「${preset.name}」完整效果；旧来源需明确确认后才能保存为可复用风格`)
  }

  function prepareAsset(lut) {
    if (busy) return
    try {
      const candidate =
        lut.kind === 'portable_style'
          ? applyStyleRecipe(lut.recipe, params)
          : normalizeParams(lut.params)
      setPendingAsset({ lut, candidate, request: captureRequest() })
    } catch (e) {
      setStatus(`无法载入：${e.message}`)
    }
  }
  const applyAsset = async () => {
    if (!pendingAsset || busy) return
    const { lut, candidate, request } = pendingAsset
    if (!requestMatches(request)) {
      setPendingAsset(null)
      setStatus('草稿已变化，请重新预览资产候选')
      return
    }
    const unlockFields = confirmConflicts(candidate)
    if (unlockFields === null) return
    const identity = `${lut.id}:${lut.revision_id}`
    const repeated =
      lut.kind === 'portable_style' &&
      workspace.recipe_projection.applied_recipes.includes(identity)
    if (repeated && !window.confirm('该风格已追加过。再次追加会累积，仍要继续？')) return
    const inputChanged =
      JSON.stringify(inputContract(params)) !== JSON.stringify(inputContract(candidate))
    if (
      inputChanged &&
      !window.confirm(
        '此完整效果使用不同的输入基准或显示映射。确认替换后，请选择匹配的样张进行预览。仍要载入？',
      )
    )
      return
    setRemoteBusy(true)
    try {
      const allowedLocks = workspace.locked_fields.filter((k) => !unlockFields.includes(k))
      await ensureRemote()
      const checked = await applyLut(
        lut.id,
        {
          params,
          context: { ...context, locked_fields: allowedLocks },
          revision_id: lut.revision_id,
          allow_repeat: repeated,
          allow_input_change: inputChanged,
        },
        primaryCompatible && sampleMatches(primarySample, candidate) ? primaryMedia?.blob : null,
      )
      if (!requestMatches(request)) {
        setStatus('草稿已变化，候选未应用')
        return
      }
      if (!equivalentCandidate(checked.params, candidate))
        throw new Error('资产候选与服务端校验结果不一致，请重新载入')
      let next
      if (lut.kind === 'portable_style') {
        const recipe = { ...lut.recipe, id: lut.id, revision: lut.revision_id }
        next = editor.applyRecipe(recipe, { unlockFields, allowRepeat: repeated })
      } else
        next = editor.commit(checked.params, {
          source: 'asset',
          unlockFields,
          replaceBaseline: true,
        })
      if (next) {
        setPendingAsset(null)
        setSavedAsset(lut)
        setStatus(
          `${lut.kind === 'portable_style' ? '已在当前效果上追加风格' : '已替换当前完整参数'}${checked.validation_status === 'not_verified' ? '；尚未验证图像效果' : '；已检查主样张新增风险'}`,
        )
      }
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }

  const addSamples = async (files) => {
    if (busy) return
    const sourceWorkspaceId = workspace.id
    setSampleLoading(true)
    let nextSamples = [...samples],
      nextMedia = new Map(media)
    try {
      for (const file of files) {
        const existing = rebindingId ? nextSamples.find((s) => s.id === rebindingId) : null
        if (!existing && nextSamples.length >= 5) throw new Error('最多保留 5 张样张')
        const decoded = await decodeSample(file, params, existing)
        if (currentRef.current.id !== sourceWorkspaceId) return
        const metadata = {
          ...decoded.metadata,
          input_confirmed: existing?.input_confirmed || false,
        }
        nextSamples = existing
          ? nextSamples.map((s) => (s.id === existing.id ? metadata : s))
          : [...nextSamples, metadata]
        nextMedia.set(metadata.id, decoded)
        setSelectedId(metadata.id)
        if (retainPreviews) await editor.cachePreview(metadata.id, decoded.blob, metadata)
        if (currentRef.current.id !== sourceWorkspaceId) return
        if (rebindingId) break
      }
      setMedia(nextMedia)
      await editor.setMeta({
        samples: nextSamples,
        primary_sample_id: primaryId || nextSamples[0]?.id,
        validation: validation ? { ...validation, stale: true } : null,
      })
      setComparison(null)
      setStatus('样张已载入，请确认照片输入基准')
    } catch (e) {
      setStatus(e.message)
    } finally {
      setSampleLoading(false)
      setRebindingId(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }
  const confirmSample = async (id, contract) => {
    const ws = currentRef.current
    const sample = ws.samples.find((item) => item.id === id)
    if (!sample) return
    setSampleLoading(true)
    try {
      let confirmed = { ...sample, input_contract: contract, input_confirmed: true }
      if (!sampleIsNormalized(confirmed)) {
        const item = mediaRef.current.get(id)
        if (!item?.file) throw new Error('请先重新绑定原文件，再统一色彩并确认输入')
        const decoded = await decodeSample(item.file, params, { ...sample, input_contract: contract })
        if (currentRef.current.id !== ws.id) return
        confirmed = { ...decoded.metadata, input_confirmed: true }
        setMedia((previous) => new Map(previous).set(id, decoded))
        if (ws.retain_previews) await editor.cachePreview(id, decoded.blob, confirmed)
      }
      if (currentRef.current.id !== ws.id) return
      await editor.setMeta({ samples: ws.samples.map((item) => item.id === id ? confirmed : item),
        validation: ws.validation ? { ...ws.validation, stale: true } : null })
      if (currentRef.current.id === ws.id)
        setStatus(`已确认 ${sample.name} 的 ${contract.base_photo_style} 照片输入`)
    } catch (failure) { setStatus(failure.message) }
    finally { setSampleLoading(false) }
  }

  const removeSample = (id) => {
    const remaining = samples.filter((s) => s.id !== id)
    setMedia((prev) => {
      const map = new Map(prev)
      map.delete(id)
      return map
    })
    editor.setMeta({
      samples: remaining,
      primary_sample_id:
        primaryId === id
          ? remaining.find((s) => s.input_confirmed && sampleMatches(s, params))?.id || null
          : primaryId,
      validation: validation ? { ...validation, stale: true } : null,
    })
    if (selectedId === id) setSelectedId(remaining[0]?.id || null)
  }
  const retain = async (enabled) => {
    if (busy) return
    setRemoteBusy(true)
    editor.setMeta({ retain_previews: enabled })
    try {
      if (!enabled) await editor.clearPreviews()
      else
        for (const sample of samples) {
          const item = media.get(sample.id)
          if (item) await editor.cachePreview(sample.id, item.blob, sample)
        }
    } catch (e) {
      setStatus(`本机预览未保存：${e.message}`)
    } finally {
      setRemoteBusy(false)
    }
  }

  const validate = async () => {
    if (busy) return
    const measurable = samples.filter((s) => media.get(s.id)?.blob && s.input_confirmed)
    const unavailable = samples
      .filter((s) => !measurable.includes(s))
      .map((s) => ({
        id: s.id,
        status: 'unmeasurable',
        summary: '无法测量',
        reason: !s.input_confirmed ? '请先确认照片输入基准' : '需绑定照片或恢复预览',
      }))
    setValidating(true)
    const request = captureRequest(),
      paramsKey = parameterSignature(params),
      samplesKey = sampleKey
    try {
      await ensureRemote()
      const result = measurable.length
        ? await validateWorkspace(
            workspace.id,
            params,
            measurable.map((s) => ({
              id: s.id,
              input_contract: s.input_contract,
              source_digest: s.source_digest,
              origin: media.get(s.id).metadata.origin,
            })),
            measurable.map((s) => media.get(s.id).blob),
          )
        : { results: [] }
      if (!requestMatches(request)) {
        setStatus('工作区已变化，统计结果未覆盖当前验证')
        return
      }
      editor.setMeta({
        validation: {
          ...result,
          results: [...result.results, ...unavailable],
          _params_json: paramsKey,
          _samples_json: samplesKey,
          measured_at: Date.now(),
        },
      })
      setStatus('统计验证完成；结果反映新增可测风险，不代表风格优劣')
    } catch (e) {
      setStatus(`验证失败：${e.message}`)
    } finally {
      setValidating(false)
    }
  }

  const saveAsset = async (data) => {
    await ensureRemote()
    const source = versionSource(workspace)
    const metadata = {
      kind: data.kind,
      recipe: data.recipe || null,
      input_contract: inputContract(params),
      workspace_id: workspace.id,
      source,
      tags: data.tags,
      group: data.group,
      favorite: data.favorite,
      cover_id: data.cover_id,
    }
    const asset =
      data.replace && savedAsset
        ? await updateLut(savedAsset.id, {
            name: data.name,
            revision_id: savedAsset.revision_id,
            description: data.description,
            params: data.params,
            ...metadata,
          })
        : await createLut(data.name, data.description, data.params, metadata)
    setSavedAsset(asset)
    setStatus(`已保存「${data.name}」，当前草稿保持原效果`)
  }

  const saveVersion = async (name) => {
    if (busy) return false
    const workspaceId = workspace.id
    setRemoteBusy(true)
    try {
      await ensureRemote()
      const source = versionSource(workspace)
      const version = await createVersion(workspace.id, {
        name,
        params,
        context,
        source,
        sample_refs: samples.map(({ id, name, source_digest, input_contract }) => ({
          id,
          name,
          source_digest,
          input_contract,
        })),
        validation_summary: validation && !validationStale ? { results: validation.results } : null,
      })
      if (currentRef.current.id === workspaceId && version.workspace_id === workspaceId) {
        setVersions((v) => [version, ...v])
        setStatus(`已保存版本「${name}」`)
      }
      return true
    } catch (e) {
      setStatus(e.message)
      return false
    } finally {
      setRemoteBusy(false)
    }
  }
  const changeVersion = async (id, name) => {
    if (busy) return
    const workspaceId = workspace.id
    setRemoteBusy(true)
    try {
      if (name) await renameVersion(workspaceId, id, name)
      else await deleteVersion(workspaceId, id)
      if (currentRef.current.id === workspaceId)
        setVersions((v) =>
          name ? v.map((x) => (x.id === id ? { ...x, name } : x)) : v.filter((x) => x.id !== id),
        )
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }
  const restoreVersion = (version) => {
    const unlockFields = confirmConflicts(version.params)
    if (unlockFields === null) return
    const inputChanged =
      params.base_photo_style !== version.params.base_photo_style ||
      params.tone_map !== version.params.tone_map
    if (
      inputChanged &&
      !window.confirm(
        '该版本使用不同输入基准或显示映射。确认使用其已保存的输入条件？当前样张会重新检查兼容性。',
      )
    )
      return
    const restored = editor.restoreVersion(version, { unlockFields, confirmInput: inputChanged })
    if (!restored) return
    setStatus(`已恢复「${version.name}」到当前草稿，可撤销`)
  }
  const compare = (side, item) =>
    setComparison((prev) => ({
      ...(prev || {}),
      [side]: {
        id: item.id,
        name: item.name,
        created_at: item.created_at,
        params: structuredClone(item.params),
      },
    }))
  const comparisonSampleMatches =
    !!selectedSample?.input_confirmed &&
    !!selectedMedia &&
    (!comparison?.a || sampleMatches(selectedSample, comparison.a.params)) &&
    (!comparison?.b || sampleMatches(selectedSample, comparison.b.params))

  const updateSplit = (clientX) => {
    const rect = gradedRef.current?.getBoundingClientRect()
    if (!rect?.width) return
    const x = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width))
    setSplit(x)
    setSplitState(x)
  }
  const downloadCube = (mode) => {
    try {
      const name = workspace.name.trim() || '未命名 LUT'
      const filename =
        mode === 'camera'
          ? cameraFileName(name)
          : `${name}_${params.base_photo_style === 'VLOG' ? 'VLOG_to_Rec709' : `${params.base_photo_style}_sRGB`}.cube`
      saveTextFile(paramsToCube(params, { title: name, mode }), filename)
      setStatus(`已下载当前完整效果：${filename}`)
    } catch (e) {
      setStatus(e.message)
    }
  }
  const backup = () => saveTextFile(editor.backup(), `CHROMA_${workspace.id}.json`)
  const reportHistorical = reportIsHistorical(gradeResult, { params, primaryId, sourceDigest: primarySample?.source_digest, context })
  const curvesVisible = toolTab === 'manual' && curvesOpen
  const curvesChanged = Object.values(params.curve_points).some(points => points.some(([x, y]) => Math.abs(x - y) > 1e-9))
  const activeAiIntent = grading ? 'optimize' : sending ? 'text' : referenceBusy ? 'reference' : null

  return (
    <div className="gen-workbench">
      <header className="workbench-header">
        <button className="btn workspace-history-toggle" aria-label="打开工作区历史" onClick={() => setWorkspaceHistory(true)}>历史</button>
        <label className="workspace-select">
          工作区
          <select
            value={workspace.id}
            aria-label="工作区"
            onChange={(e) => openWorkspace(e.target.value)}
            disabled={busy}
          >
            <option value={workspace.id}>
              {workspace.name ||
                remoteWorkspaces.find((w) => w.id === workspace.id)?.name ||
                '当前调色工作区'}
            </option>
            {remoteWorkspaces
              .filter((w) => w.id !== workspace.id)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name || `工作区 ${w.id.slice(0, 8)}`}
                </option>
              ))}
          </select>
        </label>
        <WorkspaceToolbar mode="header" editor={editor} busy={busy} onNew={newWorkspace} onBackup={backup}
          onHistory={direction => setStatus(direction === 'undo' ? '已撤销上一项调整' : '已重做上一项调整')} />
        <div className="delivery-actions">
          <button className="btn" onClick={() => setToolTab('versions')}>版本</button>
          <button className="btn-primary" disabled={busy} onClick={() => setSaveDialog(true)}>保存至我的 LUT</button>
          <details className="delivery-menu"><summary className="btn">导出 ▾</summary><div className="delivery-options">
            <strong>LUT · 烘焙当前完整效果</strong>
            <button className="btn" disabled={busy || !!resourceError} onClick={e => { e.currentTarget.closest('details').open = false; downloadCube('camera') }}>机内 LUT · .cube</button>
            <button className="btn" disabled={busy || !!resourceError} onClick={e => { e.currentTarget.closest('details').open = false; downloadCube('software') }}>后期 LUT · .cube</button>
            <strong>调整后照片</strong>
            <button className="btn" disabled={busy || !compatible || !selectedMedia?.file || !!resourceError} onClick={e => { e.currentTarget.closest('details').open = false; setPhotoExport(true) }}>导出照片 · JPEG / PNG</button>
            {(!compatible || !selectedMedia?.file) && <p>照片导出需要绑定原文件并确认输入；兼容缓存预览仍可用于手调与 LUT 导出。</p>}
            <button className="btn" disabled={busy} onClick={e => { e.currentTarget.closest('details').open = false; setCameraGuide({ sample: selectedSample }) }}>相机导入说明</button>
          </div></details>
        </div>
      </header>
      {status && <div className="workbench-notice" role="status"><span>{status}</span>{activeAiIntent && !(toolTab === 'ai' && aiIntent === activeAiIntent) && <button className="btn" onClick={() => { setToolTab('ai'); setAiIntent(activeAiIntent) }}>{grading ? '查看作业与取消' : '查看当前操作'}</button>}</div>}
      <div className="workbench-body">
        <section className={`photo-workspace ${curvesVisible ? 'curves-open' : ''}`} aria-label="照片工作区">
        <div className="preview-toolbar">
          <label className="mode-select">
            展示形式
            <select value={displayMode} onChange={(e) => setDisplayMode(e.target.value)}>
              {DISPLAY_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <span className="text-muted">
            {selectedSample ? `正在查看：${selectedSample.name}` : '合成示意图 · 不参与 AI 分析'}
          </span>
          <button
            className="upload-sm"
            disabled={busy || samples.length >= 5}
            onClick={() => {
              setRebindingId(null)
              fileInputRef.current?.click()
            }}
          >
            上传样张
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple={!rebindingId}
            style={{ display: 'none' }}
            onChange={(e) => addSamples([...e.target.files])}
          />
        </div>
        <p className="input-context">
          {params.base_photo_style === 'VLOG'
            ? '输入需为未经显示转换的 V-Log/V-Gamut 帧；普通 JPEG 不代表 V-Log 信号。'
            : `当前 LUT 需要 ${params.base_photo_style} Photo Style 的相机直出信号。`}
        </p>
        <div className="photo-stage" style={{ '--photo-ratio': selectedMedia?.canvas ? selectedMedia.canvas.width / selectedMedia.canvas.height : 800 / 560 }}>
        {comparison && (
          <ComparisonPreview
            image={selectedMedia?.canvas}
            a={comparison.a}
            b={comparison.b}
            compatible={comparisonSampleMatches}
          />
        )}
        <div hidden={!!comparison}>
          {samples.length > 0 && (!selectedMedia || !compatible) && (
            selectedMedia ? <SampleInputPreview key={`${workspace.id}:${selectedSample.id}:${selectedSample.input_contract?.base_photo_style}`}
              sample={selectedSample} media={selectedMedia} params={params} busy={busy}
              onConfirm={contract => confirmSample(selectedSample.id, contract)}
              onRebind={() => { setRebindingId(selectedSample.id); fileInputRef.current?.click() }}
              onDetails={() => setDetailsRequest(value => value + 1)} onInput={() => setToolTab('manual')} /> :
            <div className="preview-empty">
              样张文件仅保留于上次页面内存，请重新绑定照片。
              <div className="preview-empty-actions">
                <button className="btn-primary" disabled={busy} onClick={() => {
                  setRebindingId(selectedSample.id); fileInputRef.current?.click()
                }}>重新绑定照片</button>
                <button className="btn" onClick={() => setToolTab('manual')}>检查 LUT 输入</button>
              </div>
            </div>
          )}
          <div hidden={samples.length > 0 && (!selectedMedia || !compatible)}>
            {displayMode === 'slider' ? (
              <div
                className="slider-wrap"
                onPointerDown={(e) => {
                  draggingRef.current = true
                  e.currentTarget.setPointerCapture(e.pointerId)
                  updateSplit(e.clientX)
                }}
                onPointerMove={(e) => draggingRef.current && updateSplit(e.clientX)}
                onPointerUp={() => {
                  draggingRef.current = false
                }}
                onPointerCancel={() => {
                  draggingRef.current = false
                }}
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
          </div>
        </div>
        </div>
        <SampleGallery
          detailsRequest={detailsRequest}
          samples={samples}
          media={media}
          selectedId={selectedSample?.id}
          primaryId={primaryId}
          validation={validation}
          stale={validationStale}
          busy={busy}
          onSelect={setSelectedId}
          onPrimary={(id) => {
            editor.setMeta({ primary_sample_id: id })
            setStatus('已更换 AI 主样张并保留当前参数；现有校正可能来自此前样张')
          }}
          onRemove={removeSample}
          onConfirm={confirmSample}
          onAdd={() => {
            setRebindingId(null)
            fileInputRef.current?.click()
          }}
          onRebind={(id) => {
            setRebindingId(id)
            fileInputRef.current?.click()
          }}
          onValidate={validate}
          retainPreviews={retainPreviews}
          onRetain={retain}
          onGuide={(sample) => setCameraGuide({ sample: sample || selectedSample })}
        />
          <DiagnosticsPanel compact image={selectedMedia?.canvas} params={params} compatible={compatible} sampleName={selectedSample?.name} />
          {(resourceError || previewError) && <p className="draft-error" role="alert">效果未能生成：{resourceError || previewError}</p>}
          <div className="curve-workbench" id="curve-workbench" hidden={!curvesVisible}>
            <div className="curve-workbench-heading"><h3>自由曲线 · 四通道</h3><button className="btn" onClick={() => setCurvesOpen(false)}>收起曲线</button></div>
            <div className="curve-workbench-body">
          <CurveEditor key={`curves:${workspace.id}`} params={params} disabled={busy || !curvesVisible} locked={workspace.locked_fields}
            onBegin={() => editor.begin({ source: 'curve', purpose: 'style' })}
            onPreview={editor.update}
            onCommit={(patch) => editor.commit(patch, { source: 'curve', purpose: 'style' })}
            onCancel={editor.cancel} />
            </div>
          </div>
        </section>
        <aside className="task-panel" aria-label="调色工具">
          <div className="task-tabs" role="tablist" aria-label="调色任务">
            {TOOL_TABS.map(([key, label], index) => <button key={key} id={`tool-${key}`} role="tab" aria-selected={toolTab === key} aria-controls={`tool-panel-${key}`} tabIndex={toolTab === key ? 0 : -1}
              onClick={() => setToolTab(key)} onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? TOOL_TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TOOL_TABS.length) % TOOL_TABS.length
                setToolTab(TOOL_TABS[next][0]); document.getElementById(`tool-${TOOL_TABS[next][0]}`)?.focus()
              }}>{label}{key === 'ai' && activeAiIntent ? ' · 运行中' : ''}</button>)}
          </div>
          <section className="tool-view" id="tool-panel-ai" role="tabpanel" aria-labelledby="tool-ai" hidden={toolTab !== 'ai'}>
            <h2 className="tool-heading">形成你想要的效果</h2>
            <div className="ai-intents" role="group" aria-label="创作方式">{AI_INTENTS.map(([key, label]) => <button key={key} aria-pressed={aiIntent === key} onClick={() => setAiIntent(key)}>{label}</button>)}</div>
            <WorkspaceToolbar mode="context" editor={editor} busy={busy} onBackup={backup} />
            <div className="ai-context"><span>AI 主样张</span><strong>{primarySample?.name || '尚未选择'}</strong>
              {primaryId !== selectedSample?.id && primarySample && <p>当前正在查看 {selectedSample?.name}。照片优化与参考匹配使用主样张，开始时会切回该照片。</p>}
            </div>
            <div className="ai-method" hidden={aiIntent !== 'optimize'}>
              <h3 className="tool-subheading">根据照片分析并应用调整</h3>
        <AutoRetouchBar
          file={primaryMedia?.file}
          params={params}
          context={context}
          workspaceId={workspace.id}
          sourceDigest={primarySample?.source_digest}
          mainSampleId={primaryId}
          sampleName={primarySample?.name}
          hasRealPhoto={!!primaryMedia?.file && primaryCompatible}
          disabled={busy}
          running={grading}
          setRunning={setGrading}
          setStatus={setStatus}
          onBeforeRun={async () => {
            setSelectedId(primaryId)
            setComparison(null)
            const request = captureRequest()
            try {
              if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试保存')
              await ensureRemote()
              return request
            } catch (e) {
              setStatus(e.message)
              return false
            }
          }}
          userId={user}
          workspaceReady={ready}
          getAppliedJob={(id) => (currentRef.current.applied_auto_job_ids || []).includes(id)}
          onResult={(result, request, meta) => applyAutoResult(result, meta, request)}
          onRestoreResult={(result, meta) => applyAutoResult(result, meta)}
        />
        {!primaryCompatible && samples.length > 0 && (
          <p className="workspace-note">
            AI 主样张需要确认输入并与当前基准一致；查看其他缩略图不会更换主样张。
          </p>
        )}
            </div>
            <div className="ai-method text-adjustment" hidden={aiIntent !== 'text'}>
            <label className="text-adjustment-label" htmlFor="text-adjustment">描述想要的变化</label>
            <textarea id="text-adjustment" value={input} onChange={e => setInput(e.target.value)} disabled={busy}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send() }}
              placeholder="例如：冷调一点，降低绿色饱和度，保留高光层次。" maxLength={4000} />
            <button className="btn-primary" disabled={busy || !input.trim()} onClick={send}>{sending ? '正在提取调整项…' : '发送文字调整'}</button>
            <p className="tool-note">按返回的调整项更新当前效果。对话中的生成确认与参数更新会分别提示。⌘ / Ctrl + Enter 发送。</p>
            <details className="preset-options"><summary>从预设开始</summary><div className="preset-chips">
              {PRESETS.map(p => <button key={p.name} className="chip" disabled={busy} onClick={() => applyPreset(p)}>{p.name}</button>)}
            </div></details>
            <div className="latest-reply" aria-live="polite">{sending ? '正在提取调整项…' : messages.filter(m => m.role === 'agent').at(-1)?.text}</div>
            <details className="chat-history"><summary>查看本工作区对话记录 · {messages.length} 条</summary><div className="chat-messages">
              {messages.map((m, i) => <div key={i} className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-agent'}`}>{m.text}</div>)}
            </div></details>
            </div>
            <div className="ai-method" hidden={aiIntent !== 'reference'}>
      <ReferenceMatchDialog key={`reference:${workspace.id}`} inline visible={toolTab === 'ai' && aiIntent === 'reference'} disabled={busy} file={primaryMedia?.file} image={primaryMedia?.canvas}
        params={params} context={context} workspaceId={workspace.id} sourceDigest={primarySample?.source_digest}
        mainSampleId={primaryId} compatible={primaryCompatible} onClose={() => setAiIntent('optimize')}
        onBusyChange={value => { setRemoteBusy(value); setReferenceBusy(value) }} onStatus={setStatus} onPrepare={async () => {
          setSelectedId(primaryId)
          setComparison(null)
          const request = captureRequest()
          if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试保存')
          await ensureRemote()
          return request
        }} onApply={async (result, request) => {
          if (!requestMatches(request)) return false
          const next = editor.commit(result.params, { source: 'reference', purpose: 'style' })
          if (!next) return false
          if (!(await editor.flush())) throw new Error('候选未能保存，请重试草稿保存')
          setSelectedId(primaryId); setComparison(null); setStatus('参考匹配候选已应用，可一次撤销')
          return true
        }} />
            </div>
            <div className="ai-result">
        {gradeResult && (
          <AutoRetouchReport
            result={gradeResult}
            beforeParams={gradeResult.before_params}
            historical={reportHistorical}
            applied={Boolean(gradeResult.job_id && workspace.applied_auto_job_ids?.includes(gradeResult.job_id))}
            onUndo={
              !busy && !reportHistorical && editor.histories.past.at(-1)?.source === 'auto'
                ? () => { editor.undo(); setStatus('已撤销本次 AI 调整') }
                : undefined
            }
          />
        )}
            </div>
          </section>
          <section className="tool-view" id="tool-panel-manual" role="tabpanel" aria-labelledby="tool-manual" hidden={toolTab !== 'manual'}>
        <fieldset className="params param-groups" disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <h3 className="tool-heading">微调当前效果</h3>
          <p className="tool-note">基础调整优先；已调整或受保护的高级项会在标题中提示。</p>
          {PARAM_GROUPS.map((g) => {
            const fields =
              g.id === 'rgb' ? RGB_GROUPS.map((r) => r.key) : g.sliders.map((s) => s.key)
            return (
              <section key={g.id} className="param-group">
                <div className="param-group-header">
                  <button
                    type="button"
                    className="param-group-head"
                    aria-expanded={groupOpen[g.id]}
                    onClick={() => setGroupOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
                  >
                    <span className="param-group-arrow">{groupOpen[g.id] ? '▾' : '▸'}</span>
                    <span className="param-group-label">{g.label}</span>
                    <span className="param-group-hint">{groupSummary(g, params)}{fields.filter(locked).length ? ` · ${fields.filter(locked).length} 项已保护` : ''}</span>
                  </button>
                  <button className="parameter-lock" onClick={() => toggleLock(fields)}>
                    {fields.every(locked) ? '解锁组' : '保护组'}
                  </button>
                  <button
                    className="group-reset"
                    onClick={() => {
                      editor.reset(fields)
                      setStatus(`已复位未保护项，保留 ${fields.filter(locked).length} 项`)
                    }}
                  >
                    复位
                  </button>
                </div>
                {groupOpen[g.id] && (
                  <div className="controls">
                    {g.id === 'rgb'
                      ? RGB_GROUPS.map((rg) => (
                          <div key={rg.key} className="rgb-group">
                            <div className="rgb-group-title">
                              <span className="rgb-group-label">{rg.label}</span>
                              {lockButton(rg.key)}
                            </div>
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
                                  disabled={locked(rg.key)}
                                  {...gesture}
                                  onChange={(e) =>
                                    updateChannel(rg.key, idx, Number(e.target.value))
                                  }
                                />
                                <em>{params[rg.key][idx].toFixed(2)}</em>
                              </label>
                            ))}
                          </div>
                        ))
                      : g.sliders.map((sl) => (
                          <div
                            key={sl.key}
                            className={`slider ${locked(sl.key) ? 'protected' : ''}`}
                          >
                            <span>{sl.label}</span>
                            <input
                              type="range"
                              aria-label={sl.label}
                              min={sl.min}
                              max={sl.max}
                              step={sl.step}
                              value={params[sl.key]}
                              disabled={locked(sl.key)}
                              {...gesture}
                              onChange={(e) => updateParam(sl.key, Number(e.target.value))}
                            />
                            <em>
                              {Number(params[sl.key]).toFixed(2)}
                              {sl.unit}
                            </em>
                            {lockButton(sl.key)}
                          </div>
                        ))}
                  </div>
                )}
              </section>
            )
          })}
          <div className="all-parameter-actions">
            <button className="btn" onClick={() => editor.setLocks(Object.keys(params))}>
              保护全部参数
            </button>
            <button className="btn" onClick={() => editor.setLocks([])}>
              解除全部保护
            </button>
            <button
              className="btn"
              onClick={() =>
                editor.reset(
                  Object.keys(params).filter((k) => !['base_photo_style', 'tone_map'].includes(k)),
                )
              }
            >
              复位全部未保护调色项
            </button>
          </div>
          <button type="button" className="curve-workbench-toggle" aria-expanded={curvesOpen} aria-controls="curve-workbench" onClick={() => setCurvesOpen(value => !value)}>
            <span>自由曲线 · 主 / R / G / B</span><small>{curvesChanged ? '已调整' : '未调整'}{locked('curve_points') ? ' · 已保护' : ''} · {curvesOpen ? '收起' : '展开'}</small>
          </button>
          <details className="professional-settings">
            <summary>外部 LUT · {params.external_lut_id ? `${Math.round(params.external_lut_strength * 100)}% 已叠加` : '未叠加'}{locked('external_lut_id') ? ' · 已保护' : ''}</summary>
          <ImportedLutPanel key={`imported:${workspace.id}`} params={params} disabled={baseBusy} onLoading={setAdvancedLoading}
            locked={workspace.locked_fields} onError={(error) => setStatus(error.message)} onReady={() => setResourceError('')}
            onCommit={(patch) => editor.commit(patch, { source: 'external_lut', purpose: 'style' })} />
          </details>
          <div className="advanced-locks">
            <button className="parameter-lock" onClick={() => toggleLock(['curve_points'])}>{locked('curve_points') ? '解除自由曲线保护' : '保护自由曲线'}</button>
            <button className="parameter-lock" onClick={() => toggleLock(['external_lut_id', 'external_lut_strength', 'external_lut_mode'])}>{locked('external_lut_id') ? '解除外部 LUT 保护' : '保护外部 LUT'}</button>
          </div>
          <details className="professional-settings" open={workspace.input_status === 'pending_confirmation'}>
            <summary>输入技术设置 · {params.base_photo_style}{locked('base_photo_style') ? ' · 已保护' : ''}</summary>
          <div className="controls">
            <div className="slider ps-select">
              <span>基准</span>
              <select
                aria-label="LUT 输入基准"
                disabled={locked('base_photo_style')}
                value={params.base_photo_style}
                onChange={(e) =>
                  editor.commit(
                    { base_photo_style: e.target.value },
                    { source: 'input', purpose: 'technical' },
                  )
                }
              >
                {PHOTO_STYLES.map((st) => (
                  <option key={st.value} value={st.value}>
                    {st.label}
                  </option>
                ))}
              </select>
              {lockButton('base_photo_style')}
            </div>
            {params.base_photo_style === 'VLOG' && (
              <div className="slider">
                <span>V-Log 显示映射</span>
                <input
                  type="range"
                  aria-label="V-Log 显示映射"
                  min={0}
                  max={1}
                  step={0.01}
                  value={params.tone_map}
                  {...gesture}
                  disabled={locked('tone_map') || (params.external_lut_id && params.external_lut_mode === 'input')}
                  onChange={(e) => updateParam('tone_map', Number(e.target.value))}
                />
                <em>{params.tone_map.toFixed(2)}</em>
                {lockButton('tone_map')}
              </div>
            )}
          </div>
          <p className="text-muted">
            冷暖是相对 RGB 偏移，风格强度为 0
            仍保留输入转换、曝光和白平衡。参数保护仅禁止字段修改，不能保证某个区域像素完全不变。
          </p>
          {workspace.input_status === 'pending_confirmation' && (
            <div className="draft-error">
              输入或显示映射已改变，旧配方需要重新确认。
              <button
                className="btn"
                disabled={!compatible || !selectedMedia}
                onClick={() => setInputConfirmation(true)}
              >
                预览并确认配方的新输入
              </button>
            </div>
          )}
          </details>
        </fieldset>
          </section>
          <section className="tool-view" id="tool-panel-versions" role="tabpanel" aria-labelledby="tool-versions" hidden={toolTab !== 'versions'}>
            <label className="workspace-name-label">工作区 / LUT 名称<input className="name-input" value={workspace.name} onChange={e => editor.setMeta({ name: e.target.value })} placeholder="为当前效果命名" aria-label="LUT 名称" disabled={busy} /></label>
        <VersionPanel
          expanded
          versions={versions}
          busy={busy}
          draft={workspace}
          comparison={comparison}
          onSave={saveVersion}
          onCompare={compare}
          onCloseCompare={() => setComparison(null)}
          onRestore={restoreVersion}
          onRename={changeVersion}
          onDelete={(id) => changeVersion(id)}
        />
        {workspace.baseline?.classification === 'unclassified' && (
          <details className="baseline-confirmation">
            <summary>旧完整效果的来源未分类：保存可复用风格前需要确认</summary>
            <p>勾选要作为固定风格目标保留的旧字段。未选项明确排除，仅保留此后新增的风格贡献。</p>
            <div className="baseline-field-list">
              {Object.keys(params)
                .filter((k) => !['base_photo_style', 'tone_map'].includes(k))
                .map((k) => (
                  <label key={k}>
                    <input
                      type="checkbox"
                      checked={baselineFields.includes(k)}
                      onChange={(e) =>
                        setBaselineFields((prev) =>
                          e.target.checked ? [...prev, k] : prev.filter((v) => v !== k),
                        )
                      }
                    />
                    {labelFor(k)}
                  </label>
                ))}
            </div>
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                editor.confirmBaseline(baselineFields)
                setStatus(
                  baselineFields.length
                    ? '已明确分类所选旧参数为固定风格目标'
                    : '已明确排除旧基线，保留新增风格贡献',
                )
              }}
            >
              确认所选分类
            </button>
          </details>
        )}
          </section>
        </aside>
      </div>
      {workspaceHistory && <WorkbenchDialog title="工作区历史" onClose={() => setWorkspaceHistory(false)}>
        <p className="tool-note">从顶部选择工作区，或在这里打开此前对话对应的调色工作区。</p>
          <div className="session-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${s.id === workspace.session_id ? 'active' : ''}`}
              >
                <button
                  className="session-title"
                  disabled={busy}
                  onClick={async () => { await openSession(s.id); setWorkspaceHistory(false) }}
                  onDoubleClick={async () => {
                    const title = window.prompt('历史对话名称', s.title)
                    if (title?.trim()) {
                      await updateSession(s.id, title.trim())
                      listSessions().then(setSessions)
                    }
                  }}
                >
                  {s.title}
                </button>
                <button
                  className="session-del"
                  disabled={busy}
                  onClick={() => removeSession(s.id)}
                  title="删除历史对话"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
      </WorkbenchDialog>}
      {photoExport && <PhotoExportDialog sample={selectedSample} media={selectedMedia} params={params}
        compatible={compatible} onClose={() => setPhotoExport(false)} onBusyChange={setRemoteBusy} />}
      {inputConfirmation && (
        <InputConfirmationDialog
          workspace={workspace}
          image={compatible ? selectedMedia?.canvas : null}
          onClose={() => setInputConfirmation(false)}
          onConfirm={() => {
            if (editor.confirmRecipeInput()) setInputConfirmation(false)
          }}
        />
      )}
      {cameraGuide && (
        <CameraGuideDialog
          params={params}
          name={workspace.name}
          sample={cameraGuide.sample}
          onClose={() => setCameraGuide(null)}
          onDownload={() => downloadCube('camera')}
        />
      )}
      {saveDialog && (
        <StyleSaveDialog
          workspace={workspace}
          image={selectedMedia?.canvas}
          compatible={compatible}
          onClose={() => setSaveDialog(false)}
          onSave={saveAsset}
          savedAsset={savedAsset}
        />
      )}
      {pendingAsset && (
        <div className="modal-backdrop">
          <section
            className="workspace-modal"
            role="dialog"
            aria-modal="true"
            aria-label="载入调色资产"
          >
            <h2>「{pendingAsset.lut.name}」</h2>
            <p>
              {pendingAsset.lut.kind === 'portable_style'
                ? '在当前效果上追加风格'
                : '替换当前完整参数'}
              ；候选预览尚未应用。
            </p>
            {selectedMedia &&
              selectedSample?.input_confirmed &&
              sampleMatches(selectedSample, pendingAsset.candidate) && (
                <RenderedImage
                  image={selectedMedia.canvas}
                  params={pendingAsset.candidate}
                  label="载入候选预览"
                />
              )}
            <p>
              {diffParams(params, pendingAsset.candidate)
                .map((c) => c.text)
                .join('；') || '参数相同'}
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPendingAsset(null)}>
                取消
              </button>
              <button className="btn-primary" onClick={applyAsset} disabled={busy}>
                {pendingAsset.lut.kind === 'portable_style' ? '追加风格' : '替换完整参数'}
              </button>
            </div>
          </section>
        </div>
      )}
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
    const onUnauthorized = () => {
      clearExternalLutCache()
      setUser(null)
      setPreviewLut(null)
    }
    window.addEventListener('chroma:unauthorized', onUnauthorized)
    return () => window.removeEventListener('chroma:unauthorized', onUnauthorized)
  }, [])

  useEffect(() => {
    // me() 未登录时返回 null(不是抛错)—— 见 lib/api.js 的说明
    me()
      .then((u) => setUser(u ? u.username : null))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))
  }, [])

  const openPreview = (lut) => {
    setPreviewLut({ ...lut, params: { ...lut.params } })
    setView('generate')
  }

  const handleLogout = async () => {
    clearExternalLutCache()
    try {
      await apiLogout()
    } catch {
      // 忽略退出失败,本地仍清登录态
    }
    setUser(null)
    setPreviewLut(null)
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
        {view !== 'landing' && (
          <header className="topbar">
            <div className="brand">
              <span className="logo">C</span>
              CHROMA
            </div>
            <nav className="nav">
              {/* 首页是入口,排在两个子页之前;用一条分隔线与应用内导航区分开 */}
              <button className="nav-home" onClick={() => setView('landing')}>
                首页
              </button>
              <button
                className={view === 'generate' ? 'active' : ''}
                onClick={() => setView('generate')}
              >
                生成
              </button>
              <button
                className={view === 'library' ? 'active' : ''}
                onClick={() => setView('library')}
              >
                我的 LUT
              </button>
            </nav>
            <div className="topbar-user">
              <ThemePicker />
              <span>{user}</span>
              <button className="btn" onClick={handleLogout}>
                退出
              </button>
            </div>
          </header>
        )}
        <div style={{ display: view === 'generate' ? undefined : 'none' }}>
          <GenerateView key={user} previewLut={previewLut} user={user} />
        </div>
        {view === 'library' && <LibraryView onPreview={openPreview} />}
      </div>
    </>
  )
}
