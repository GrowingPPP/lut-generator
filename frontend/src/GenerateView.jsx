import CurveEditorUrl from './components/CurveEditor.jsx?lazy-url'
import ImportedLutPanelUrl from './components/ImportedLutPanel.jsx?lazy-url'
import ReferenceMatchDialogUrl from './components/ReferenceMatchDialog.jsx?lazy-url'
import PhotoExportDialogUrl from './components/PhotoExportDialog.jsx?lazy-url'
import PhotoViewerUrl from './components/PhotoViewer.jsx?lazy-url'
import PhotoAdjustmentsUrl from './components/PhotoAdjustments.jsx?lazy-url'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultParams, normalizeParams } from './lib/lutEngine.js'
import usePreview from './hooks/usePreview.js'
import useWorkspace from './hooks/useWorkspace.js'
import { ModalSurface, useDialogs } from './components/ui/Dialog.jsx'
import ActionMenu from './components/ui/ActionMenu.jsx'
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from './components/ui/Tabs.jsx'
import RangeField from './components/ui/RangeField.jsx'
import CheckboxField from './components/ui/CheckboxField.jsx'
import Tooltip from './components/ui/Tooltip.jsx'
import ProtectionButton from './components/ui/ProtectionButton.jsx'
import ActionIcon from './components/ui/ActionIcon.jsx'
import { inputContract, applyStyleRecipe } from './lib/styleRecipe.js'
import { lockConflicts } from './lib/workspace.js'
import { duplicateProjectName } from './lib/projectManagement.js'
import { decodeSample, restoreSample, sampleMatches, sampleIsNormalized, editingContextForSample } from './lib/samples.js'
import { mergeRestoredMedia, sampleMediaMatches } from './lib/sampleMedia.js'
import { diffParams } from './lib/autoGrade.js'
import { parameterSignature, effectivePhases, versionSource, equivalentCandidate, contextSignature, reportIsHistorical } from './lib/workspaceFlow.js'
import WorkspaceToolbar from './components/WorkspaceToolbar.jsx'
import ProjectManager, { projectName } from './components/ProjectManager.jsx'
import InputConfirmationDialog from './components/InputConfirmationDialog.jsx'
import SampleGallery from './components/SampleGallery.jsx'
import SubjectProtectionPanel from './components/SubjectProtectionPanel.jsx'
import { effectiveSubjectProtection, normalizeSubjectDetection, subjectSelection, SUBJECT_ANALYSIS_VERSION } from './lib/subjectAnalysis.js'
import SampleInputPreview from './components/SampleInputPreview.jsx'
import VersionPanel from './components/VersionPanel.jsx'
import StyleSaveDialog from './components/StyleSaveDialog.jsx'
import CameraGuideDialog from './components/CameraGuideDialog.jsx'
import DiagnosticsPanel from './components/DiagnosticsPanel.jsx'
import ComparisonPreview, { RenderedImage } from './components/ComparisonPreview.jsx'
import {
  createLut, chatSession,
  listSessions, createSession, deleteSession, updateSession, listMessages,
  saveTextFile, cameraFileName, listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, listVersions, createVersion, renameVersion, deleteVersion, applyLut, validateWorkspace, updateLut, getAutoReport, analyzePhotoSubjects,
} from './lib/api.js'
import { paramsToCube } from './lib/lutEngine.js'
import { sameAutoMetadata } from './lib/autoJobs.js'
import { preloadExternalLut } from './lib/importedLuts.js'
import ParameterControls from './components/ParameterControls.jsx'
import ParameterHelp from './components/ParameterHelp.jsx'
import SelectField from './components/SelectField.jsx'
import { defaultGroupOpen, parameterLabel } from './lib/parameterControls.js'
import { makeTestImage } from './lib/preview.js'
import { compatibleVersionInputs } from './lib/versionComparison.js'
import AutoRetouchBar from './components/AutoRetouchBar.jsx'
import AutoRetouchReport from './components/AutoRetouchReport.jsx'
import { DeferredFeature, lazyFeature } from './components/FeatureLoader.jsx'
import './GenerationWorkspace.css'

const CurveEditor = lazyFeature(() => import('./components/CurveEditor.jsx'), '自由曲线', CurveEditorUrl)
const ImportedLutPanel = lazyFeature(() => import('./components/ImportedLutPanel.jsx'), '外部 LUT', ImportedLutPanelUrl)
const ReferenceMatchDialog = lazyFeature(() => import('./components/ReferenceMatchDialog.jsx'), '参考图匹配', ReferenceMatchDialogUrl)
const PhotoExportDialog = lazyFeature(() => import('./components/PhotoExportDialog.jsx'), '照片导出', PhotoExportDialogUrl)
const PhotoViewer = lazyFeature(() => import('./components/PhotoViewer.jsx'), '照片查看器', PhotoViewerUrl)
const PhotoAdjustments = lazyFeature(() => import('./components/PhotoAdjustments.jsx'), '放大调色工具', PhotoAdjustmentsUrl)

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
  return <ModalSurface onClose={onClose}>
    <section className="workspace-modal workspace-history-drawer" aria-labelledby="workspace-history-title">
      <div className="section-heading"><h2 id="workspace-history-title">{title}</h2><button className="btn" onClick={onClose}>关闭</button></div>
      {children}
    </section>
  </ModalSurface>
}

function ToolLoadingSurface({ onClose, children }) {
  return <ModalSurface onClose={onClose}>
    <section className="workspace-modal tool-loading-modal" aria-label="正在打开照片工具">{children}</section>
  </ModalSurface>
}

const DISPLAY_MODES = [
  { value: 'slider', label: '滑动对比' },
  { value: 'split', label: '独立展示' },
]
const EMPTY_PROJECT_VIEW = { display_mode: 'slider', split: 0.5, selected_sample_id: null,
  comparison: null, tool_tab: 'ai', ai_intent: 'optimize', curves_open: false }

export default function GenerateView({ previewLut, deletedAssetId, user }) {
  const dialogs = useDialogs()
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
  const [detectingSampleId, setDetectingSampleId] = useState(null)
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
  const [projectManager, setProjectManager] = useState(false)
  const [localProjects, setLocalProjects] = useState([])
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectError, setProjectError] = useState('')
  const [retiredProjectIds, setRetiredProjectIds] = useState([])
  const [detailsRequest, setDetailsRequest] = useState(0)
  const [photoExport, setPhotoExport] = useState(false)
  const [photoViewer, setPhotoViewer] = useState(false)
  const [resourceLoading, setResourceLoading] = useState(false)
  const [resourceError, setResourceError] = useState('')
  const [savedAsset, setSavedAsset] = useState(null)
  const [pendingAsset, setPendingAsset] = useState(null)
  const [baselineFields, setBaselineFields] = useState([])
  const [media, setMedia] = useState(new Map())
  const [selectedId, setSelectedId] = useState(null)
  const [sampleBinding, setSampleBinding] = useState(null)
  const originalRef = useRef(null)
  const gradedRef = useRef(null)
  const curveWorkbenchRef = useRef(null)
  const curveEntryRef = useRef(null)
  const mainCurveRef = useRef(null)
  const photoAdjustmentsRef = useRef(null)
  const draggingRef = useRef(false)
  const fileInputRef = useRef(null)
  const fileSelectionRef = useRef(null)
  const openRequestRef = useRef(0)
  const projectOperationRef = useRef(false)
  const recoveringProjectsRef = useRef(new Set())
  const remoteRequests = useRef(new Map())
  const consumedPreviewRef = useRef(null)
  const deletedAssetIds = useRef(new Set())
  const subjectRequestRef = useRef(0)
  const subjectMountedRef = useRef(true)
  useEffect(() => { subjectMountedRef.current = true; return () => { subjectMountedRef.current = false; subjectRequestRef.current += 1 } }, [])
  const viewWorkspaceRef = useRef(null)
  const mediaRef = useRef(media)
  mediaRef.current = media
  const currentRef = useRef(workspace)
  currentRef.current = workspace
  const finishMainAdjustment = useCallback(() => {
    mainCurveRef.current?.finishPendingEdit()
    editor.commit()
  }, [editor.commit])
  const undoAdjustment = useCallback(() => { finishMainAdjustment(); editor.undo() }, [finishMainAdjustment, editor.undo])
  const redoAdjustment = useCallback(() => { finishMainAdjustment(); editor.redo() }, [finishMainAdjustment, editor.redo])
  const toolbarEditor = { ...editor, undo: undoAdjustment, redo: redoAdjustment }
  useEffect(() => {
    if (deletedAssetId == null) return
    deletedAssetIds.current.add(deletedAssetId)
    setSavedAsset(current => current?.id === deletedAssetId ? null : current)
    setPendingAsset(current => current?.lut.id === deletedAssetId ? null : current)
  }, [deletedAssetId])
  const baseBusy = sending || grading || validating || sampleLoading || detectingSampleId !== null || remoteBusy || resourceLoading || !ready
  const busy = baseBusy || advancedLoading
  const projects = useMemo(() => {
    const combined = new Map(localProjects.map(project => [project.id, { ...project, localOnly: true }]))
    for (const project of remoteWorkspaces) combined.set(project.id, { ...combined.get(project.id), ...project, localOnly: false })
    combined.set(workspace.id, { localOnly: true, ...combined.get(workspace.id), ...workspace })
    return [...combined.values()].filter(project => !retiredProjectIds.includes(project.id)).sort((a, b) => a.id === workspace.id ? -1 : b.id === workspace.id ? 1 :
      new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
  }, [localProjects, remoteWorkspaces, workspace, retiredProjectIds])
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
  const context = useMemo(() => editingContextForSample(workspace, primarySample),
    [workspace.goal_mode, workspace.locked_fields, primarySample])
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
      editingContextForSample(workspace, s),
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
      name: projectName(ws),
    })
      .then((record) => {
        setRemoteWorkspaces((prev) =>
          prev.some((v) => v.id === record.id) ? prev : [record, ...prev],
        )
        return record
      })
      .catch((e) => {
        remoteRequests.current.delete(ws.id)
        if (e.status === 410) void recoverDeletedProject(ws.id)
        throw e
      })
    remoteRequests.current.set(ws.id, request)
    return request
  }

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => setStatus(e.message))
    void refreshProjects()
  }, [])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    fileSelectionRef.current = null
    setSampleBinding(null)
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
    setPhotoViewer(false)
    setSavedAsset(null)
    setBaselineFields([])
    ensureRemote(workspace)
      .then(() => listVersions(workspace.id))
      .then((v) => {
        if (!cancelled) setVersions(v)
      })
      .catch((e) => {
        if (!cancelled) {
          if (e.status === 410) void recoverDeletedProject(workspace.id)
          else setStatus(`调色项目同步失败：${e.message}`)
        }
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
              if (cached?.metadata && !sampleMediaMatches({ metadata: cached.metadata }, sample)) continue
              restored.set(sample.id, await restoreSample(blob, sample))
            } catch {
              /* A missing preview leaves the sample available for rebinding. */
            }
          }
        }
      }
      if (!cancelled && currentRef.current.id === workspace.id)
        setMedia(current => mergeRestoredMedia(current, restored, currentRef.current.samples))
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
        e.defaultPrevented ||
        !(e.ctrlKey || e.metaKey) ||
        e.key.toLowerCase() !== 'z' ||
        busy ||
        saveDialog ||
        inputConfirmation ||
        pendingAsset ||
        workspaceHistory || projectManager ||
        photoExport ||
        photoViewer ||
        /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) ||
        e.target.closest?.('[role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="dialog"], [role="alertdialog"], [data-chroma-popover-content]')
      )
        return
      e.preventDefault()
      if (e.shiftKey && editor.canRedo) {
        redoAdjustment()
        setStatus('已重做上一项调整')
      } else if (!e.shiftKey && editor.canUndo) {
        undoAdjustment()
        setStatus('已撤销上一项调整')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoAdjustment, redoAdjustment, editor.canUndo, editor.canRedo, busy, saveDialog, inputConfirmation, pendingAsset, workspaceHistory, projectManager, photoExport, photoViewer])

  const captureRequest = () => {
    const ws = currentRef.current
    return {
      workspace_id: ws.id,
      params_json: parameterSignature(ws.params),
      context_json: contextSignature(editingContextForSample(ws, (ws.samples || []).find(s => s.id === ws.primary_sample_id))),
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
      context: editingContextForSample(ws, sample),
      main_sample_id: ws.primary_sample_id, source_digest: sample?.source_digest }
    if ((request && !requestMatches(request)) || !sameAutoMetadata(meta?.requestSummary, current)
      || parameterSignature(result.before_params) !== parameterSignature(ws.params)
      || result.workspace_id !== ws.id || result.source_digest !== sample?.source_digest
      || result.main_sample_id !== ws.primary_sample_id || result.job_id !== meta?.jobId) {
      setStatus('调色项目、参数或主样张已变化，本次响应未应用')
      return false
    }
    if ((ws.applied_auto_job_ids || []).includes(meta.jobId)) return true
    await preloadExternalLut(result.params.external_lut_id)
    const latest = currentRef.current
    const latestSample = latest.samples.find(item => item.id === latest.primary_sample_id)
    if (!sameAutoMetadata(meta.requestSummary, { workspace_id: latest.id, params: latest.params,
      context: editingContextForSample(latest, latestSample),
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


  const recoverDeletedProject = async (id) => {
    if (recoveringProjectsRef.current.has(id)) return
    recoveringProjectsRef.current.add(id)
    setRetiredProjectIds(ids => [...new Set([...ids, id])])
    remoteRequests.current.delete(id)
    await editor.retireProject(id)
    setRemoteWorkspaces(items => items.filter(item => item.id !== id))
    setLocalProjects(items => items.filter(item => item.id !== id))
    if (currentRef.current.id === id) {
      await editor.loadWorkspace({ sessionId: null })
      setStatus('此调色项目已被删除，已切换到可用草稿')
    }
  }

  const refreshProjects = async () => {
    setProjectLoading(true)
    setProjectError('')
    const results = await Promise.allSettled([listWorkspaces(), editor.listProjects(), editor.deletedProjectIds()])
    if (results[2].status === 'fulfilled') {
      setRetiredProjectIds(ids => [...new Set([...ids, ...results[2].value])])
      const cleanup = await Promise.allSettled(results[2].value.map(id =>
        currentRef.current.id === id ? recoverDeletedProject(id) : editor.retireProject(id)))
      if (cleanup.some(result => result.status === 'rejected' || result.value === false))
        setProjectError('部分已删除项目的本机缓存尚未清理，请重试同步')
    }
    if (results[0].status === 'fulfilled') setRemoteWorkspaces(results[0].value)
    else setProjectError(`项目列表同步失败：${results[0].reason.message}`)
    if (results[1].status === 'fulfilled' && results[1].value) setLocalProjects(results[1].value)
    else if (results[1].status === 'fulfilled') setProjectError('本机项目读取失败，请查看草稿保存提示')
    else setProjectError(`本机项目读取失败：${results[1].reason.message}`)
    setProjectLoading(false)
  }

  const manageProjects = () => {
    setProjectManager(true)
    void refreshProjects()
  }

  const newWorkspace = async () => {
    if (busy || projectOperationRef.current) return
    projectOperationRef.current = true
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
        name: '未命名调色项目',
        view_state: EMPTY_PROJECT_VIEW,
      })
      if (!loaded) throw new Error('未能创建新草稿，请查看本机保存提示')
      setSessions((prev) => [session, ...prev])
      await ensureRemote(loaded)
      setProjectManager(false)
      setStatus('已创建新的调色项目')
    } catch (e) {
      setStatus(e.message)
    } finally {
      projectOperationRef.current = false
      setRemoteBusy(false)
    }
  }

  const loadProject = async (record) => {
    const id = record.id
    const request = ++openRequestRef.current
    const local = (await editor.listProjects())?.find(project => project.id === id)
    let detached = false
    const msgs = record?.session_id ? await listMessages(record.session_id).catch(error => {
      if (!local) throw error
      detached = error.status === 404
      return []
    }) : []
    if (request !== openRequestRef.current) return
    const last = [...msgs].reverse().find((m) => m.role === 'agent' && m.params)
    let loaded = await editor.loadWorkspace({
      id,
      params: last?.params || defaultParams(),
      legacy: true,
      sessionId: record?.session_id,
      name: record?.name || '',
    })
    if (!loaded) throw new Error('草稿未能载入，请查看本机保存提示')
    if (detached) {
      loaded = editor.setMeta({ session_id: null }) || loaded
      await updateWorkspace(id, { session_id: null }).catch(error => { if (error.status !== 404) throw error })
    }
    let syncError
    await ensureRemote(loaded).catch(error => {
      if (!local || error.status === 410 || error.status === 401) throw error
      syncError = error.message
    })
    return { ...loaded, syncError }
  }

  const openWorkspace = async (id) => {
    if (busy || projectOperationRef.current || id === workspace.id) return
    projectOperationRef.current = true
    setRemoteBusy(true)
    try {
      if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      const record = projects.find((w) => w.id === id)
      if (!record) throw new Error('调色项目已不存在，请刷新项目列表')
      const loaded = await loadProject(record)
      if (!loaded) return
      setProjectManager(false)
      setStatus(loaded.syncError ? `已恢复本机草稿；账户同步失败：${loaded.syncError}` : '已载入调色项目；本机草稿优先恢复')
    } catch (e) {
      if (e.status === 410) void recoverDeletedProject(id)
      setStatus(e.message)
    } finally {
      projectOperationRef.current = false
      setRemoteBusy(false)
    }
  }

  const renameProject = async (id = workspace.id) => {
    if (busy || projectOperationRef.current) return
    const source = projects.find(project => project.id === id)
    if (!source) return
    const ownerProjectId = workspace.id
    const name = await dialogs.prompt({ title: '重命名调色项目', label: '项目名称',
      description: '仅修改项目名称，已保存的 LUT 和版本名称保持不变。',
      defaultValue: projectName(source), maxLength: 160 })
    if (name == null || currentRef.current.id !== ownerProjectId || projectOperationRef.current) return
    projectOperationRef.current = true
    setRemoteBusy(true)
    try {
      if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      await ensureRemote(source)
      const remote = await updateWorkspace(id, { name })
      remoteRequests.current.set(id, Promise.resolve(remote))
      setRemoteWorkspaces(items => items.map(item => item.id === id ? remote : item))
      if (!(await editor.renameProject(name, id))) throw new Error('项目名称已同步到账户，本机保存失败，请重试保存')
      setLocalProjects(items => items.map(item => item.id === id ? { ...item, name } : item))
      setStatus(`已重命名项目：${name}`)
    } catch (error) {
      if (error.status === 410) void recoverDeletedProject(id)
      setStatus(error.message)
      setProjectError(error.message)
    } finally {
      projectOperationRef.current = false
      setRemoteBusy(false)
    }
  }

  const duplicateProject = async () => {
    if (busy || projectOperationRef.current) return
    projectOperationRef.current = true
    setRemoteBusy(true)
    let session
    let duplicate
    try {
      finishMainAdjustment()
      if (!(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      const name = duplicateProjectName(projectName(currentRef.current))
      session = await createSession(name)
      duplicate = await editor.duplicateProject({ id: crypto.randomUUID(), sessionId: session.id, name })
      if (!duplicate) throw new Error('副本未能保存，源项目已保留，请查看草稿提示')
      setSessions(items => [session, ...items])
      await ensureRemote(duplicate)
      setStatus('已复制当前调色效果与样张设置，可以在副本中继续创作')
    } catch (error) {
      if (session && !duplicate) await deleteSession(session.id).catch(() => {})
      setStatus(error.message)
    } finally {
      projectOperationRef.current = false
      setRemoteBusy(false)
    }
  }

  const removeProject = async (id = workspace.id) => {
    if (busy || projectOperationRef.current) return
    const source = projects.find(project => project.id === id)
    if (!source) return
    const ownerProjectId = workspace.id
    const confirmed = await dialogs.confirm({ title: `删除“${projectName(source)}”？`,
      description: '将删除此项目的草稿、预览缓存、版本、报告及专属对话记录。已保存到“我的 LUT”的成果、电脑上的原照片和已导出文件会保留。此操作无法撤销。',
      confirmLabel: '删除调色项目', destructive: true })
    if (!confirmed || currentRef.current.id !== ownerProjectId || projectOperationRef.current) return
    projectOperationRef.current = true
    setRemoteBusy(true)
    let deleted = false
    const removingCurrent = id === ownerProjectId
    let replacementId = null
    try {
      if (id !== currentRef.current.id && !(await editor.flush())) throw new Error('当前草稿未能保存，请先重试或下载备份')
      try { await deleteWorkspace(id) }
      catch (error) {
        if (!(error.status === 404 && source.localOnly)) throw error
        const registration = { ...source, name: '未命名调色项目', session_id: null }
        try { await ensureRemote(registration) }
        catch (pendingError) {
          if (pendingError.status === 404) await ensureRemote(registration)
          else throw pendingError
        }
        await deleteWorkspace(id)
      }
      deleted = true
      setRetiredProjectIds(ids => [...new Set([...ids, id])])
      remoteRequests.current.delete(id)
      const retired = await editor.retireProject(id, { broadcast: !removingCurrent })
      setRemoteWorkspaces(items => items.filter(item => item.id !== id))
      setLocalProjects(items => items.filter(item => item.id !== id))
      if (removingCurrent) {
        const next = projects.find(project => project.id !== id)
        if (next) await loadProject(next)
        else {
          const empty = await editor.loadWorkspace({ id: crypto.randomUUID(), params: defaultParams(),
            legacy: false, sessionId: null, name: '未命名调色项目', view_state: EMPTY_PROJECT_VIEW })
          if (!empty) throw new Error('空白项目未能载入，请刷新页面')
          await ensureRemote(empty)
        }
        const saved = await editor.flush()
        if (!saved) throw new Error('替代项目未能保存，请查看本机草稿提示')
        replacementId = saved.workspace.id
      }
      listSessions().then(setSessions).catch(() => {})
      setProjectError(retired ? '' : '项目已删除，本机缓存清理未完成，请重试同步')
      setStatus(retired ? '调色项目已删除；已保存 LUT 和原照片已保留' : '项目已删除，本机缓存清理未完成，请重试同步')
    } catch (error) {
      const message = deleted ? `项目已删除；切换项目失败：${error.message}` : `删除项目失败：${error.message}`
      setStatus(message)
      setProjectError(message)
    } finally {
      if (deleted && removingCurrent) editor.notifyProjectDeletion(id, replacementId)
      projectOperationRef.current = false
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
      setStatus('旧会话已转为调色项目，保存可复用风格前需确认旧参数来源')
    } catch (e) {
      setStatus(e.message)
    } finally {
      setRemoteBusy(false)
    }
  }

  const removeSession = async (id) => {
    if (busy) return
    const workspaceId = workspace.id
    if (!(await dialogs.confirm({ title: '删除历史对话？', description: '删除此会话及聊天记录。关联调色项目、版本与风格资产将保留。', confirmLabel: '删除对话', destructive: true }))) return
    if (currentRef.current.id !== workspaceId) return
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
  const labelFor = parameterLabel
  const lockButton = (key) => <ProtectionButton label={labelFor(key)} locked={locked(key)} disabled={busy} onClick={() => toggleLock([key])} />
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

  const confirmConflicts = async (candidate) => {
    const fields = lockConflicts(params, candidate, workspace.locked_fields)
    if (!fields.length) return []
    return (await dialogs.confirm({ title: '候选包含受保护参数',
      description: `以下受保护项与候选冲突：${fields.map(labelFor).join('、')}。解除这些项的保护并完整应用？`,
      confirmLabel: '解除保护并应用',
    }))
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
        setStatus('调色项目已变化，本次响应未应用')
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

  const applyPreset = async (preset) => {
    if (busy) return
    const request = captureRequest()
    const unlockFields = await confirmConflicts(preset.params)
    if (unlockFields === null) return
    if (!requestMatches(request)) { setStatus('草稿已变化，请重新选择预设'); return }
    editor.commit(preset.params, { source: 'preset', unlockFields, replaceBaseline: true })
    setStatus(`已载入「${preset.name}」完整效果；旧来源需明确确认后才能保存为可复用风格`)
  }

  function prepareAsset(lut) {
    if (busy || deletedAssetIds.current.has(lut.id)) return
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
    if (deletedAssetIds.current.has(lut.id)) {
      setPendingAsset(null)
      return
    }
    if (!requestMatches(request)) {
      setPendingAsset(null)
      setStatus('草稿已变化，请重新预览资产候选')
      return
    }
    const unlockFields = await confirmConflicts(candidate)
    if (unlockFields === null) return
    const identity = `${lut.id}:${lut.revision_id}`
    const repeated =
      lut.kind === 'portable_style' &&
      workspace.recipe_projection.applied_recipes.includes(identity)
    if (repeated && !(await dialogs.confirm({ title: '再次追加这个风格？', description: '该风格已追加过。再次追加会累积当前效果。', confirmLabel: '再次追加' }))) return
    const inputChanged =
      JSON.stringify(inputContract(params)) !== JSON.stringify(inputContract(candidate))
    if (
      inputChanged &&
      !(await dialogs.confirm({ title: '载入不同输入条件的效果？',
        description: '此完整效果使用不同的输入基准或显示映射。确认替换后，请选择匹配的样张进行预览。', confirmLabel: '确认载入' }))
    )
      return
    if (deletedAssetIds.current.has(lut.id) || !requestMatches(request)) {
      setPendingAsset(null)
      setStatus('草稿或资产已变化，请重新预览候选')
      return
    }
    setRemoteBusy(true)
    try {
      const allowedLocks = workspace.locked_fields.filter((k) => !unlockFields.includes(k))
      await ensureRemote()
      const checked = await applyLut(
        lut.id,
        {
          params,
          context: { ...context, locked_fields: allowedLocks },
          source_digest: primarySample?.source_digest,
          revision_id: lut.revision_id,
          allow_repeat: repeated,
          allow_input_change: inputChanged,
        },
        primaryCompatible && sampleMatches(primarySample, candidate) ? primaryMedia?.blob : null,
      )
      if (deletedAssetIds.current.has(lut.id)) {
        setPendingAsset(null)
        setStatus('该资产已删除，候选未应用')
        return
      }
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

  const openSamplePicker = (sampleId = null) => {
    const current = currentRef.current
    fileSelectionRef.current = { workspaceId: current.id, userId: current.user_id, sampleId }
    const input = fileInputRef.current
    if (input) {
      input.value = ''
      input.multiple = !sampleId
      input.click()
    }
  }

  const addSamples = async (event) => {
    const files = [...event.target.files]
    const selection = fileSelectionRef.current
    fileSelectionRef.current = null
    event.target.value = ''
    if (!files.length) return
    const sourceWorkspace = currentRef.current
    const isCurrent = () => currentRef.current.id === sourceWorkspace.id
      && currentRef.current.user_id === sourceWorkspace.user_id
    if (!selection || selection.workspaceId !== sourceWorkspace.id || selection.userId !== sourceWorkspace.user_id) {
      setStatus('调色项目已变化，请在当前项目重新选择照片')
      return
    }
    const feedback = (phase, message) => {
      if (!isCurrent()) return
      setSampleBinding({ workspaceId: sourceWorkspace.id, sampleId: selection.sampleId, phase, message })
      setStatus(message)
    }
    if (busy) {
      feedback('error', '当前操作尚未完成，照片未绑定。请等待完成后重新选择同一文件。')
      return
    }
    const rebindingId = selection.sampleId
    setSampleLoading(true)
    feedback('loading', `${rebindingId ? '正在重新绑定' : '正在载入'} ${files[0].name}…`)
    let nextSamples = [...sourceWorkspace.samples]
    const decodedMedia = new Map()
    try {
      if (rebindingId && !nextSamples.some(sample => sample.id === rebindingId))
        throw new Error('该样张已移除，请添加为新的样张')
      for (const file of files) {
        const existing = rebindingId ? nextSamples.find((s) => s.id === rebindingId) : null
        if (!existing && nextSamples.length >= 5) throw new Error('最多保留 5 张样张')
        const decoded = await decodeSample(file, sourceWorkspace.params, existing)
        if (!isCurrent()) return
        const metadata = {
          ...decoded.metadata,
          input_confirmed: existing?.input_confirmed || false,
        }
        nextSamples = existing
          ? nextSamples.map((s) => (s.id === existing.id ? metadata : s))
          : [...nextSamples, metadata]
        decodedMedia.set(metadata.id, decoded)
        if (rebindingId) break
      }
      const updated = editor.setMeta({
        samples: nextSamples,
        primary_sample_id: sourceWorkspace.primary_sample_id || nextSamples[0]?.id,
        validation: sourceWorkspace.validation ? { ...sourceWorkspace.validation, stale: true } : null,
      })
      if (!updated) throw new Error('照片未能绑定到当前草稿，请查看草稿提示后重试')
      setMedia(previous => {
        const next = new Map(previous)
        for (const [id, decoded] of decodedMedia) next.set(id, decoded)
        return mergeRestoredMedia(next, new Map(), updated.samples)
      })
      const lastId = [...decodedMedia.keys()].at(-1)
      setSelectedId(lastId)
      setComparison(null)
      const selected = nextSamples.find(sample => sample.id === lastId)
      const message = rebindingId ? `已重新绑定 ${selected.name}，原文件已恢复`
        : `已载入 ${decodedMedia.size} 张样张`
      const inputMessage = selected.input_confirmed && sampleMatches(selected, sourceWorkspace.params)
        ? '，可继续查看效果、分析或导出照片。' : '，请确认照片输入并与当前 LUT 基准匹配。'
      feedback('success', message + inputMessage)
      if (sourceWorkspace.retain_previews) {
        for (const [id, decoded] of decodedMedia) {
          if (!isCurrent()) return
          const cached = await editor.cachePreview(id, decoded.blob, nextSamples.find(sample => sample.id === id))
          if (!cached) feedback('warning', message + inputMessage + ' 本机预览未保存，刷新后仍需重新绑定。')
        }
      }
    } catch (e) {
      feedback('error', `照片${rebindingId ? '绑定' : '载入'}失败：${e.message}`)
    } finally {
      setSampleLoading(false)
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
  const updateSubjectMetadata = async (id, patch) => {
    const ws = currentRef.current
    const sample = ws.samples.find(item => item.id === id)
    if (!sample) throw new Error('样张已移除，请重新选择照片')
    const marked = { ...sample, ...patch }
    marked.subject_mode = effectiveSubjectProtection(marked).subject_mode
    const next = editor.setMeta({ samples: ws.samples.map(item => item.id === id ? marked : item),
      validation: ws.validation ? { ...ws.validation, stale: true } : null })
    if (!next) throw new Error('照片内容未能写入草稿，请查看保存提示')
    currentRef.current = next
    const nextMedia = new Map(mediaRef.current), item = nextMedia.get(id)
    if (item) nextMedia.set(id, { ...item, metadata: marked })
    mediaRef.current = nextMedia
    setMedia(nextMedia)
    if (next.retain_previews && item?.blob) await editor.cachePreview(id, item.blob, marked)
    if (!(await editor.flush())) throw new Error('人物识别与保护区域未能保存，请先重试草稿保存')
    return marked
  }
  const changeSubjectMetadata = async (id, patch) => {
    if (busy) return
    setSampleLoading(true)
    try {
      await updateSubjectMetadata(id, patch)
      setStatus('已保存照片内容与肤色保护区域，统计验证需重新运行')
    } catch (failure) { setStatus(failure.message) }
    finally { setSampleLoading(false) }
  }
  const setSampleSubject = (id, selection) => {
    if (!['auto', 'portrait', 'non_portrait'].includes(selection)) return
    return changeSubjectMetadata(id, { subject_selection: selection })
  }
  const currentAutoConditions = () => {
    const ws = currentRef.current
    const sample = ws.samples.find(item => item.id === ws.primary_sample_id)
    return { file: mediaRef.current.get(sample?.id)?.file, params: ws.params,
      context: editingContextForSample(ws, sample), workspace_id: ws.id,
      source_digest: sample?.source_digest, main_sample_id: sample?.id }
  }
  const detectSampleSubjects = async (id, { enabled = true, force = false, isCurrent = () => true } = {}) => {
    const ws = currentRef.current
    const sample = ws.samples.find(item => item.id === id)
    if (!sample) throw new Error('样张已变化，请重新选择照片')
    const cached = normalizeSubjectDetection(sample.subject_detection, sample.source_digest, sample.input_contract?.base_photo_style)
    if (!force && cached && (!enabled || ['resolved', 'uncertain'].includes(cached.status))) return cached
    const request = captureRequest()
    const requestId = ++subjectRequestRef.current
    const stillCurrent = () => subjectMountedRef.current && requestId === subjectRequestRef.current
      && requestMatches(request) && isCurrent()
    setDetectingSampleId(id)
    let detection
    try {
      const fallback = (status, reason) => ({ version: SUBJECT_ANALYSIS_VERSION, status, subject_mode: 'unknown',
        confidence: 0, regions: [], source: 'auto', reason, mask_mode: 'skin_candidates',
        source_digest: sample.source_digest, input_style: sample.input_contract?.base_photo_style })
      if (!enabled) detection = fallback('disabled', 'disabled')
      else {
        const item = mediaRef.current.get(id)
        if (!item?.file) detection = fallback('failed', 'source_required')
        else {
          setStatus(`正在识别 ${sample.name} 的人物与肤色区域；照片将发送给模型`)
          try {
            const result = await analyzePhotoSubjects({ file: item.file, params: ws.params, source_digest: sample.source_digest })
            detection = normalizeSubjectDetection(result, sample.source_digest, sample.input_contract?.base_photo_style)
              || fallback('failed', 'invalid')
          } catch (failure) {
            if (failure.status === 401) throw failure
            detection = fallback('failed', 'failed')
          }
        }
      }
      if (!stillCurrent()) throw new Error('调色项目、参数或照片已变化，识别结果未写入草稿')
      await updateSubjectMetadata(id, { subject_detection: detection })
      if (detection.status === 'failed') setStatus('人物识别未完成，未启用自动肤色保护；可重试识别或人工框选，调色可继续')
      else if (detection.status === 'uncertain') setStatus('人物识别暂不确定，可人工修正照片内容与皮肤区域，调色可继续')
      else if (detection.status === 'resolved') setStatus('人物识别已保存，可查看或修正肤色保护区域')
      return detection
    } finally {
      if (subjectMountedRef.current && requestId === subjectRequestRef.current) setDetectingSampleId(null)
    }
  }
  const prepareAutoSubjects = async ({ useVision = true, isCurrent = () => true } = {}) => {
    const ws = currentRef.current
    const sample = ws.samples.find(item => item.id === ws.primary_sample_id)
    if (sample && subjectSelection(sample) === 'auto') {
      await detectSampleSubjects(sample.id, { enabled: useVision, isCurrent })
    }
    return currentAutoConditions()
  }
  const detectSubjectsManually = async id => {
    if (busy) return
    try { await detectSampleSubjects(id, { force: true }) }
    catch (failure) { setStatus(failure.message) }
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
            measurable.map((s) => {
              const { subject_mode, subject_detection_mode, subject_analysis, skin_regions, skin_mask_mode } = editingContextForSample(workspace, s)
              return { id: s.id, input_contract: s.input_contract, source_digest: s.source_digest,
                subject_mode, subject_detection_mode, subject_analysis, skin_regions, skin_mask_mode,
                origin: media.get(s.id).metadata.origin }
            }),
            measurable.map((s) => media.get(s.id).blob),
          )
        : { results: [] }
      if (!requestMatches(request)) {
        setStatus('调色项目已变化，统计结果未覆盖当前验证')
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
      data.replace && savedAsset && !deletedAssetIds.current.has(savedAsset.id)
        ? await updateLut(savedAsset.id, {
            name: data.name,
            revision_id: savedAsset.revision_id,
            description: data.description,
            params: data.params,
            ...metadata,
          })
        : await createLut(data.name, data.description, data.params, metadata)
    setSavedAsset(deletedAssetIds.current.has(asset.id) ? null : asset)
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
        sample_refs: samples.map(sample => ({ id: sample.id, name: sample.name, source_digest: sample.source_digest,
          input_contract: sample.input_contract, subject_mode: effectiveSubjectProtection(sample).subject_mode,
          subject_selection: subjectSelection(sample), subject_detection: sample.subject_detection || null,
          subject_regions: sample.subject_regions ?? null, subject_region_mask_mode: sample.subject_region_mask_mode || 'skin_candidates' })),
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
  const restoreVersion = async (version) => {
    if (busy) return
    const request = captureRequest()
    const unlockFields = await confirmConflicts(version.params)
    if (unlockFields === null) return
    const inputChanged =
      params.base_photo_style !== version.params.base_photo_style ||
      params.tone_map !== version.params.tone_map
    if (
      inputChanged &&
      !(await dialogs.confirm({ title: '恢复版本的输入条件？',
        description: '该版本使用不同输入基准或显示映射。确认使用其已保存的输入条件后，当前样张会重新检查兼容性。', confirmLabel: '确认恢复' }))
    )
      return
    if (!requestMatches(request)) { setStatus('草稿已变化，请重新选择恢复版本'); return }
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
  const viewerMedia = selectedMedia || (!samples.length ? { canvas: makeTestImage() } : null)
  const viewerUnavailable = !viewerMedia?.canvas ? '请先上传或重新绑定照片'
    : comparison && (!comparison.a || !comparison.b) ? '请选择版本 A 和 B 后再放大比较'
      : comparison && !compatibleVersionInputs(comparison.a.params, comparison.b.params) ? '两版输入基准不同，无法放大比较'
        : ''
  const activeAiIntent = grading ? 'optimize' : sending ? 'text' : referenceBusy ? 'reference' : null
  const openCurves = () => {
    setToolTab('manual')
    setCurvesOpen(true)
    requestAnimationFrame(() => {
      const region = curveWorkbenchRef.current
      if (!region || region.hidden) return
      region.focus({ preventScroll: true })
      const stacked = window.matchMedia('(max-width: 960px), (max-height: 620px)').matches
      const target = stacked ? region : region.querySelector('.curve-workbench-heading')
      target?.scrollIntoView({ block: stacked ? 'start' : 'nearest' })
    })
  }
  const closeCurves = () => {
    setCurvesOpen(false)
    requestAnimationFrame(() => curveEntryRef.current?.focus())
  }

  return (
    <div className="gen-workbench">
      <header className="workbench-header">
        <button className="btn btn-ghost workspace-history-toggle" aria-label="打开对话历史" onClick={() => setWorkspaceHistory(true)}>对话历史</button>
        <label className="workspace-select">
          调色项目
          <SelectField
            value={workspace.id}
            aria-label="调色项目"
            onChange={(e) => openWorkspace(e.target.value)}
            disabled={busy}
          >
            <option value={workspace.id} description="正在编辑的草稿">
              {projectName(workspace)}
            </option>
            {projects
              .filter((w) => w.id !== workspace.id)
              .map((w) => (
                <option key={w.id} value={w.id} description="切换到此调色项目">
                  {projectName(w)}
                </option>
              ))}
          </SelectField>
        </label>
        <ActionMenu label="项目管理" disabled={busy} trigger={<button type="button" className="btn btn-ghost project-management-trigger">项目管理 <span aria-hidden="true">⌄</span></button>} items={[
          { id: 'name', type: 'label', label: projectName(workspace) },
          { id: 'rename', label: '重命名项目', onSelect: () => renameProject() },
          { id: 'duplicate', label: '复制当前项目', description: '保留当前效果与样张，独立继续创作', onSelect: duplicateProject },
          { id: 'all', label: '管理全部项目', separator: true, onSelect: manageProjects },
          { id: 'delete', label: '删除当前项目', description: '保留已保存 LUT 和原照片', separator: true, destructive: true, onSelect: () => removeProject() },
        ]} />
        <WorkspaceToolbar mode="header" editor={toolbarEditor} busy={busy} onNew={newWorkspace} onBackup={backup}
          onHistory={direction => setStatus(direction === 'undo' ? '已撤销上一项调整' : '已重做上一项调整')} />
        <div className="delivery-actions">
          <button className="btn btn-ghost" onClick={() => setToolTab('versions')}>版本</button>
          <button className="btn-primary" disabled={busy} onClick={() => setSaveDialog(true)}>保存至我的 LUT</button>
          <ActionMenu label="导出选项" trigger={<button type="button" className="btn btn-soft">导出 <span aria-hidden="true">⌄</span></button>} items={[
            { id: 'lut-label', type: 'label', label: 'LUT · 当前完整效果' },
            { id: 'camera', label: '机内 LUT · .cube', description: resourceError ? '请先重新载入外部 LUT 资源' : busy ? '当前操作完成后可导出' : '用于相机导入', disabled: busy || !!resourceError, onSelect: () => downloadCube('camera') },
            { id: 'software', label: '后期 LUT · .cube', description: resourceError ? '请先重新载入外部 LUT 资源' : busy ? '当前操作完成后可导出' : '用于后期软件调色', disabled: busy || !!resourceError, onSelect: () => downloadCube('software') },
            { id: 'photo-divider', type: 'separator' },
            { id: 'photo-label', type: 'label', label: '调整后照片' },
            { id: 'photo', label: '导出照片 · JPEG / PNG', description: resourceError ? '请先重新载入外部 LUT 资源' : busy ? '当前操作完成后可导出' : !compatible || !selectedMedia?.file ? '需要绑定原文件并确认照片输入' : '使用当前调整效果导出', disabled: busy || !compatible || !selectedMedia?.file || !!resourceError, onSelect: () => setPhotoExport(true) },
            { id: 'guide-divider', type: 'separator' },
            { id: 'guide', label: '相机导入说明', description: busy ? '当前操作完成后可查看' : '查看输入基准与相机导入步骤', disabled: busy, onSelect: () => setCameraGuide({ sample: selectedSample }) },
          ]} />
        </div>
      </header>
      {status && <div className="workbench-notice" role="status"><span>{status}</span>{activeAiIntent && !(toolTab === 'ai' && aiIntent === activeAiIntent) && <button className="btn" onClick={() => { setToolTab('ai'); setAiIntent(activeAiIntent) }}>{grading ? '查看作业与取消' : '查看当前操作'}</button>}</div>}
      <div className="workbench-body">
        <section className={`photo-workspace ${curvesVisible ? 'curves-open' : ''}`} aria-label="照片调色项目" tabIndex={0}>
        <div className="preview-toolbar">
          <label className="mode-select">
            展示形式
            <SelectField aria-label="展示形式" value={displayMode} onChange={(e) => setDisplayMode(e.target.value)}>
              {DISPLAY_MODES.map((m) => (
                <option key={m.value} value={m.value} description={m.value === 'slider' ? '在同一画面拖动分界比较' : '同时查看原图与当前效果'}>
                  {m.label}
                </option>
              ))}
            </SelectField>
          </label>
          <span className="text-muted">
            {selectedSample ? `正在查看：${selectedSample.name}` : '合成示意图 · 不参与 AI 分析'}
          </span>
          <Tooltip content={viewerUnavailable || '放大照片查看细节，可打开调色面板边看边调整'}><button type="button" className="btn photo-viewer-launch" aria-label="放大查看照片"
            disabled={!!viewerUnavailable}
            onClick={() => setPhotoViewer(true)}>放大查看</button></Tooltip>
          <button type="button" className="btn btn-ghost curve-quick-toggle" ref={curveEntryRef}
            aria-expanded={curvesVisible} aria-controls="curve-workbench"
            onClick={() => curvesVisible ? closeCurves() : openCurves()}>
            自由曲线{curvesVisible ? ' · 收起' : curvesChanged ? ' · 已调整' : ''}
          </button>
          <button
            className={samples.length ? 'btn btn-ghost upload-sm' : 'btn-primary upload-sm'}
            disabled={busy || samples.length >= 5}
            onClick={() => openSamplePicker()}
          >
            <ActionIcon name="upload" />上传样张
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={addSamples}
            onCancel={() => { fileSelectionRef.current = null }}
          />
        </div>
        <p className="input-context">
          {params.base_photo_style === 'VLOG'
            ? '输入需为未经显示转换的 V-Log/V-Gamut 帧；普通 JPEG 不代表 V-Log 信号。'
            : `当前 LUT 需要 ${params.base_photo_style} Photo Style 的相机直出信号。`}
        </p>
        {sampleBinding?.workspaceId === workspace.id && (!sampleBinding.sampleId || sampleBinding.sampleId === selectedSample?.id) && (
          <p className="sample-binding-status" data-phase={sampleBinding.phase}
            role={sampleBinding.phase === 'error' ? 'alert' : 'status'}>{sampleBinding.message}</p>
        )}
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
              onRebind={() => openSamplePicker(selectedSample.id)}
              onDetails={() => setDetailsRequest(value => value + 1)} onInput={() => setToolTab('manual')} /> :
            <div className="preview-empty">
              样张文件仅保留于上次页面内存，请重新绑定照片。
              <div className="preview-empty-actions">
                <button className="btn-primary" disabled={busy} onClick={() => openSamplePicker(selectedSample.id)}>重新绑定照片</button>
                <button className="btn btn-ghost" onClick={() => setToolTab('manual')}>检查 LUT 输入</button>
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
        <div className="curve-workbench" id="curve-workbench" ref={curveWorkbenchRef} role="region" aria-label="自由曲线 · 四通道" tabIndex={-1} hidden={!curvesVisible}>
          <div className="curve-workbench-heading"><h3>自由曲线 · 四通道</h3><div className="curve-heading-actions"><ProtectionButton label="自由曲线" locked={locked('curve_points')} compact={false} disabled={busy} onClick={() => toggleLock(['curve_points'])} /><button className="btn btn-ghost" onClick={closeCurves}>收起曲线</button></div></div>
          <div className="curve-workbench-body">
            <DeferredFeature active={curvesVisible}><CurveEditor ref={mainCurveRef} key={`curves:${workspace.id}`} params={params} disabled={busy || !curvesVisible} locked={workspace.locked_fields}
              onBegin={() => editor.begin({ source: 'curve', purpose: 'style' })}
              onPreview={editor.update}
              onCommit={(patch) => editor.commit(patch, { source: 'curve', purpose: 'style' })}
              onCancel={editor.cancel} /></DeferredFeature>
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
          onSubjectChange={setSampleSubject}
          onAdd={() => openSamplePicker()}
          onRebind={openSamplePicker}
          onValidate={validate}
          retainPreviews={retainPreviews}
          onRetain={retain}
          onGuide={(sample) => setCameraGuide({ sample: sample || selectedSample })}
        />
          <DiagnosticsPanel compact image={selectedMedia?.canvas} params={params} compatible={compatible} sampleName={selectedSample?.name} />
          {(resourceError || previewError) && <p className="draft-error" role="alert">效果未能生成：{resourceError || previewError}</p>}
        </section>
        <TabsRoot asChild value={toolTab} onValueChange={setToolTab}>
        <aside className="task-panel" aria-label="调色工具">
          <TabsList className="task-tabs" aria-label="调色任务">
            {TOOL_TABS.map(([key, label]) => <TabsTrigger key={key} value={key}>{label}{key === 'ai' && activeAiIntent ? ' · 运行中' : ''}</TabsTrigger>)}
          </TabsList>
          <div className="manual-tool-shortcuts feature-protection-heading" hidden={toolTab !== 'manual'}>
            <button type="button" className="curve-workbench-toggle" aria-expanded={curvesOpen} aria-controls="curve-workbench" onClick={() => curvesOpen ? closeCurves() : openCurves()}>
              <span>自由曲线 · 主 / R / G / B</span><small>{curvesChanged ? '已调整' : '未调整'}{locked('curve_points') ? ' · 已保护' : ''} · {curvesOpen ? '收起' : '展开'}</small>
            </button>
            <ProtectionButton label="自由曲线" locked={locked('curve_points')} compact={false} disabled={busy} onClick={() => toggleLock(['curve_points'])} />
          </div>
          <TabsContent value="ai" forceMount asChild><section className="tool-view">
            <h2 className="tool-heading">形成你想要的效果</h2>
            <div className="ai-intents" role="group" aria-label="创作方式">{AI_INTENTS.map(([key, label]) => <button key={key} aria-pressed={aiIntent === key} onClick={() => setAiIntent(key)}>{label}</button>)}</div>
            <WorkspaceToolbar mode="context" editor={toolbarEditor} busy={busy} onBackup={backup} />
            <div className="ai-context"><span>AI 主样张</span><strong>{primarySample?.name || '尚未选择'}</strong>
              {primaryId !== selectedSample?.id && primarySample && <p>当前正在查看 {selectedSample?.name}。照片优化与参考匹配使用主样张，开始时会切回该照片。</p>}
            </div>
            {primarySample && <div className="ai-subject-protection"><SubjectProtectionPanel sample={primarySample}
              previewUrl={primaryMedia?.thumbnail} busy={busy} detecting={detectingSampleId === primaryId}
              onDetect={primaryCompatible && primaryMedia?.file ? () => detectSubjectsManually(primaryId) : undefined}
              onSelectionChange={selection => setSampleSubject(primaryId, selection)}
              onRegionsChange={regions => changeSubjectMetadata(primaryId, { subject_regions: regions,
                ...(regions === null ? { subject_region_mask_mode: 'skin_candidates' } : {}) })}
              onMaskModeChange={mode => changeSubjectMetadata(primaryId, { subject_region_mask_mode: mode })} /></div>}
            <div className="ai-method" hidden={aiIntent !== 'optimize'}>
              <h3 className="tool-subheading">根据照片分析并应用调整</h3>
        <AutoRetouchBar
          onPrepare={prepareAutoSubjects}
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
            <details className="chat-history"><summary>查看本调色项目对话记录 · {messages.length} 条</summary><div className="chat-messages">
              {messages.map((m, i) => <div key={i} className={`msg ${m.role === 'user' ? 'msg-user' : 'msg-agent'}`}>{m.text}</div>)}
            </div></details>
            </div>
            <div className="ai-method" hidden={aiIntent !== 'reference'}>
      <DeferredFeature active={toolTab === 'ai' && aiIntent === 'reference'}><ReferenceMatchDialog key={`reference:${workspace.id}`} inline visible={toolTab === 'ai' && aiIntent === 'reference'} disabled={busy} file={primaryMedia?.file} image={primaryMedia?.canvas}
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
        }} /></DeferredFeature>
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
                ? () => { undoAdjustment(); setStatus('已撤销本次 AI 调整') }
                : undefined
            }
          />
        )}
            </div>
          </section></TabsContent>
          <TabsContent value="manual" forceMount asChild><section className="tool-view">
        <fieldset className="params param-groups" disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <h3 className="tool-heading">微调当前效果</h3>
          <p className="tool-note">基础调整优先；已调整或受保护的高级项会在标题中提示。</p>
          <ParameterControls
            params={params}
            contextKey={workspace.id}
            lockedFields={workspace.locked_fields}
            disabled={busy}
            groupOpen={groupOpen}
            onGroupOpen={setGroupOpen}
            gesture={gesture}
            onUpdateParam={updateParam}
            onUpdateChannel={updateChannel}
            onToggleLock={toggleLock}
            onSetLocks={editor.setLocks}
            onReset={(fields, group) => {
              editor.reset(fields)
              if (group) setStatus(`已复位未保护项，保留 ${fields.filter(locked).length} 项`)
            }}
          />
          <details className="professional-settings">
            <summary className="feature-protection-heading"><span>外部 LUT · {params.external_lut_id ? `${Math.round(params.external_lut_strength * 100)}% 已叠加` : '未叠加'}</span><ProtectionButton label="外部 LUT" compact={false}
              locked={['external_lut_id', 'external_lut_strength', 'external_lut_mode'].every(locked)}
              mixed={['external_lut_id', 'external_lut_strength', 'external_lut_mode'].some(locked) && !['external_lut_id', 'external_lut_strength', 'external_lut_mode'].every(locked)} disabled={busy}
              onClick={event => { event.preventDefault(); event.stopPropagation(); toggleLock(['external_lut_id', 'external_lut_strength', 'external_lut_mode']) }} /></summary>
          <DeferredFeature active={toolTab === 'manual'}><ImportedLutPanel key={`imported:${workspace.id}`} params={params} disabled={baseBusy} onLoading={setAdvancedLoading}
            locked={workspace.locked_fields} onError={(error) => setStatus(error.message)} onReady={() => setResourceError('')}
            onCommit={(patch) => editor.commit(patch, { source: 'external_lut', purpose: 'style' })} /></DeferredFeature>
          </details>
          <details className="professional-settings" open={workspace.input_status === 'pending_confirmation'}>
            <summary>输入技术设置 · {params.base_photo_style}{locked('base_photo_style') ? ' · 已保护' : ''}</summary>
          <div className="controls">
            <div className="slider ps-select">
              <span>基准</span>
              <SelectField
                aria-label="LUT 输入基准"
                disabled={busy || locked('base_photo_style')}
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
              </SelectField>
              {lockButton('base_photo_style')}
            </div>
            <ParameterHelp parameter="base_photo_style" />
            {params.base_photo_style === 'VLOG' && (
              <div className="slider">
                <span>V-Log 显示映射</span>
                <RangeField
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
            {params.base_photo_style === 'VLOG' && <ParameterHelp parameter="tone_map" />}
          </div>
          <p className="text-muted">
            冷暖是相对 RGB 偏移，风格强度为 0
            仍保留输入转换、曝光和白平衡。参数保护仅禁止字段修改，不能保证某个区域像素完全不变。
          </p>
          {workspace.input_status === 'pending_confirmation' && (
            <div className="draft-error">
              输入或显示映射已改变，旧配方需要重新确认。
              <button
                className="btn btn-soft"
                disabled={!compatible || !selectedMedia}
                onClick={() => setInputConfirmation(true)}
              >
                预览并确认配方的新输入
              </button>
            </div>
          )}
          </details>
        </fieldset>
          </section></TabsContent>
          <TabsContent value="versions" forceMount asChild><section className="tool-view">
            <div className="workspace-name-label project-version-name"><span>当前调色项目<strong>{projectName(workspace)}</strong></span><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => renameProject()}>重命名</button></div>
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
                    <CheckboxField
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
          </section></TabsContent>
        </aside>
        </TabsRoot>
      </div>
      {projectManager && <ProjectManager projects={projects} currentId={workspace.id} busy={busy}
        loading={projectLoading} error={projectError} onClose={() => setProjectManager(false)} onOpen={openWorkspace}
        onNew={newWorkspace} onRename={renameProject} onDelete={removeProject} onRetry={refreshProjects} />}
      {workspaceHistory && <WorkbenchDialog title="对话历史" onClose={() => setWorkspaceHistory(false)}>
        <p className="tool-note">这里管理 AI 对话记录。调色项目的重命名、复制与删除，请使用顶部“项目管理”。</p>
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
                >
                  {s.title}
                </button>
                <button type="button" className="btn session-rename" disabled={busy}
                  aria-label={`改名历史对话 ${s.title}`} onClick={async () => {
                    const title = await dialogs.prompt({ title: '修改历史对话名称', label: '对话名称', defaultValue: s.title })
                    if (title == null) return
                    setRemoteBusy(true)
                    try { await updateSession(s.id, title); setSessions(await listSessions()) }
                    catch (error) { setStatus(error.message) }
                    finally { setRemoteBusy(false) }
                  }}>改名</button>
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
      {photoExport && <PhotoExportDialog loadingSurface={ToolLoadingSurface} loadingClose={() => setPhotoExport(false)} sample={selectedSample} media={selectedMedia} params={params}
        compatible={compatible} onClose={() => setPhotoExport(false)} onBusyChange={setRemoteBusy} />}
      {photoViewer && !viewerUnavailable && <PhotoViewer loadingSurface={ToolLoadingSurface} loadingClose={() => setPhotoViewer(false)} key={`${workspace.id}:${selectedSample?.id || 'synthetic'}`}
        sample={selectedSample} media={viewerMedia} params={params} comparison={comparison}
        compatible={comparison ? comparisonSampleMatches : !samples.length || compatible}
        initialMode={displayMode} initialSplit={split} onClose={() => setPhotoViewer(false)}
        canUndo={!busy && editor.canUndo} canRedo={!busy && editor.canRedo} onUndo={editor.undo} onRedo={editor.redo}
        onFinishAdjustment={() => photoAdjustmentsRef.current ? photoAdjustmentsRef.current.finishPendingEdit() : editor.commit()} onEditDraft={() => setComparison(null)}
        adjustmentPanel={<PhotoAdjustments ref={photoAdjustmentsRef} editor={editor} disabled={busy} gesture={gesture}
          onUpdateParam={updateParam} onUpdateChannel={updateChannel} onToggleLock={toggleLock} resourceError={resourceError} />} />}
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
        <ModalSurface onClose={() => setPendingAsset(null)} busy={busy}>
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
              <button className="btn" disabled={busy} onClick={() => setPendingAsset(null)}>
                取消
              </button>
              <button className="btn-primary" onClick={applyAsset} disabled={busy}>
                {pendingAsset.lut.kind === 'portable_style' ? '追加风格' : '替换完整参数'}
              </button>
            </div>
          </section>
        </ModalSurface>
      )}
    </div>
  )
}

