import { useCallback, useEffect, useRef, useState } from 'react'
import { createWorkspace, createWorkspaceState, beginEdit, previewEdit, commitEdit, cancelEdit, undoEdit, redoEdit,
  setWorkspaceMeta, serializeWorkspaceState, validateWorkspaceRecord, applyRecipeEdit, restoreVersionEdit,
  workspaceId } from '../lib/workspace.js'
import { createDraftStorage, draftBackup } from '../lib/draftStorage.js'
import { clone, domainError, inputContract } from '../lib/styleRecipe.js'

export default function useWorkspace({ userId = 'guest', initialParams, sessionId = null, storage } = {}) {
  const userKey = String(userId ?? 'guest')
  const [state, setState] = useState(() => createWorkspaceState({ userId: userKey, initialParams, sessionId }))
  const stateRef = useRef(state)
  const storageRef = useRef(storage || createDraftStorage())
  const [ready, setReady] = useState(false)
  const [saveStatus, setSaveStatus] = useState('loading')
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null)
  const conflictRef = useRef(null)
  const timerRef = useRef(null)
  const queueRef = useRef(Promise.resolve())
  const loadGenerationRef = useRef(0)
  const sequenceRef = useRef(0)
  const channelRef = useRef(null)
  const clientIdRef = useRef(workspaceId())
  const mountedRef = useRef(true)
  const rejectedRecordRef = useRef(null)

  const showError = useCallback((failure) => {
    if (!mountedRef.current) return
    setError(failure)
    if (failure.code === 'revision_conflict') {
      const details = { workspace_id: stateRef.current.workspace.id, revision: failure.actualRevision }
      conflictRef.current = details; setConflict(details); setSaveStatus('conflict')
    } else setSaveStatus('unsaved')
  }, [])

  const publish = useCallback((next) => {
    stateRef.current = next
    sequenceRef.current += 1
    if (mountedRef.current) { setState(next); setError(null); setSaveStatus(conflictRef.current ? 'conflict' : 'unsaved') }
    return next.workspace
  }, [])

  const flush = useCallback(() => {
    clearTimeout(timerRef.current)
    const requestedId = stateRef.current.workspace.id
    const requestedUser = stateRef.current.workspace.user_id
    const save = async () => {
      if (conflictRef.current) return null
      const current = stateRef.current
      if (current.workspace.id !== requestedId || current.workspace.user_id !== requestedUser) return null
      const sequence = sequenceRef.current
      if (mountedRef.current) setSaveStatus('saving')
      try {
        const record = serializeWorkspaceState(current)
        const saved = await storageRef.current.save(requestedUser, record, current.workspace.revision)
        if (stateRef.current.workspace.id === requestedId && stateRef.current.workspace.user_id === requestedUser) {
          // A save can finish after another edit. Only revision is adopted; the
          // newer in-memory values and provenance remain authoritative.
          const next = { ...stateRef.current, workspace: { ...stateRef.current.workspace,
            revision: saved.workspace.revision } }
          stateRef.current = next
          if (mountedRef.current) {
            setState(next)
            setSaveStatus(conflictRef.current ? 'conflict' : sequence === sequenceRef.current ? 'saved' : 'unsaved')
          }
        }
        channelRef.current?.postMessage({ user_id: requestedUser, workspace_id: requestedId,
          revision: saved.workspace.revision, client_id: clientIdRef.current })
        return saved
      } catch (failure) { showError(failure); return null }
    }
    const queued = queueRef.current.catch(() => null).then(save)
    queueRef.current = queued
    return queued
  }, [showError])

  const schedule = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flush() }, 500)
  }, [flush])

  const change = useCallback((operation, { immediate = true } = {}) => {
    try {
      const next = operation(stateRef.current)
      if (next === stateRef.current) return next.workspace
      const result = publish(next)
      if (immediate) void flush(); else schedule()
      return result
    } catch (failure) {
      // Rejected operations leave the existing edit and history untouched.
      setError(failure)
      return null
    }
  }, [flush, publish, schedule])

  const begin = useCallback((options = {}) => change((current) => beginEdit(current, options), { immediate: false }), [change])
  const update = useCallback((patch) => change((current) => previewEdit(current, patch), { immediate: false }), [change])
  const commit = useCallback((patch, options = {}) => change((current) => commitEdit(current, patch, options)), [change])
  const cancel = useCallback(() => change(cancelEdit), [change])
  const undo = useCallback(() => change(undoEdit), [change])
  const redo = useCallback(() => change(redoEdit), [change])
  const setMeta = useCallback((meta) => change((current) => setWorkspaceMeta(current, meta), { immediate: false }), [change])
  const setGoal = useCallback((goal_mode) => commit(null, { source: 'goal', context: { goal_mode } }), [commit])
  const setLocks = useCallback((locked_fields) => commit(null, { source: 'lock', context: { locked_fields } }), [commit])
  const setPurpose = useCallback((purpose) => commit(null, { source: 'purpose', context: { purpose } }), [commit])
  const reset = useCallback((fields) => commit(null, { source: 'reset', resetFields: fields }), [commit])
  const applyRecipe = useCallback((recipe, options) => change((current) => applyRecipeEdit(current, recipe, options)), [change])
  const restoreVersion = useCallback((version, options) => change((current) => restoreVersionEdit(current, version, options)), [change])
  const confirmBaseline = useCallback((fields = []) => commit(null, { source: 'baseline_confirmation', confirmBaselineFields: fields }), [commit])
  const confirmRecipeInput = useCallback(() => {
    const current = stateRef.current.workspace
    const contract = inputContract(current.params)
    const compatible = current.samples.some((sample) => sample.input_confirmed === true
      && sample.input_contract?.base_photo_style === contract.base_photo_style
      && sample.input_contract?.output_encoding === contract.output_encoding
      && (sample.preview_digest || sample.source_digest))
    if (!compatible) { setError(domainError('sample_required', '请选择当前输入基准的兼容样张后确认风格')); return null }
    return commit(null, { source: 'input_confirmation', confirmInput: true })
  }, [commit])

  const loadWorkspace = useCallback(async (options = {}) => {
    clearTimeout(timerRef.current)
    const generation = ++loadGenerationRef.current
    const current = stateRef.current
    const owner = String(options.userId ?? userKey)
    const requestedId = options.id || options.workspace?.id
    const reloadingConflict = Boolean(conflictRef.current && requestedId === current.workspace.id)
    if (current.workspace.user_id === owner && ready && !reloadingConflict && sequenceRef.current > 0) {
      const saved = await flush()
      if (!saved) return null
    }
    setReady(false); setSaveStatus('loading')
    try {
      let record = options.workspace ? options : requestedId
        ? await storageRef.current.load(owner, requestedId)
        : await storageRef.current.latest(owner, options.sessionId ?? sessionId)
      if (generation !== loadGenerationRef.current) return null
      let next
      if (record) {
        rejectedRecordRef.current = record
        next = validateWorkspaceRecord(record, owner)
        rejectedRecordRef.current = null
      } else next = createWorkspaceState({ ...options, userId: owner, sessionId: options.sessionId ?? sessionId,
        initialParams: options.initialParams || initialParams, unknown: options.unknown ?? Boolean(options.legacy) })
      stateRef.current = next; setState(next); sequenceRef.current = record ? 0 : 1
      conflictRef.current = null; setConflict(null)
      setError(next.historyWarning ? domainError('history_invalid', next.historyWarning) : null)
      setSaveStatus(record ? 'saved' : 'unsaved'); setReady(true)
      if (!record) schedule()
      return next.workspace
    } catch (failure) {
      if (generation !== loadGenerationRef.current) return null
      showError(failure)
      // Failed storage does not discard a valid current workspace. An account
      // switch must still hide the previous owner's in-memory draft.
      if (stateRef.current.workspace.user_id !== owner) {
        const next = createWorkspaceState({ ...options, userId: owner, initialParams, sessionId })
        stateRef.current = next; setState(next); sequenceRef.current = 1
      }
      setReady(true)
      return null
    }
  }, [userKey, sessionId, initialParams, flush, ready, schedule, showError])

  const fork = useCallback(async () => {
    clearTimeout(timerRef.current)
    try {
      const current = stateRef.current.pending ? commitEdit(stateRef.current) : stateRef.current
      const next = { ...current, workspace: { ...clone(current.workspace), id: workspaceId(), revision: 0,
        name: `${current.workspace.name || '调色草稿'} 副本`, associated_version: null, created_at: Date.now(), updated_at: Date.now() }, pending: null }
      conflictRef.current = null; setConflict(null)
      publish(next)
      await flush()
      return next.workspace
    } catch (failure) { showError(failure); return null }
  }, [flush, publish, showError])

  const backup = useCallback(({ diagnostic = false } = {}) => draftBackup(diagnostic && rejectedRecordRef.current
    ? rejectedRecordRef.current : serializeWorkspaceState(stateRef.current)), [])

  const cachePreview = useCallback(async (sampleId, blob, metadata = {}) => {
    const current = stateRef.current.workspace
    try { return await storageRef.current.putPreview(current.user_id, current.id, sampleId, blob, metadata) }
    catch (failure) { setError(failure); return null }
  }, [])
  const getCachedPreview = useCallback(async (sampleId) => {
    const current = stateRef.current.workspace
    try { return await storageRef.current.getPreview(current.user_id, current.id, sampleId) }
    catch (failure) { setError(failure); return null }
  }, [])
  const clearPreviews = useCallback(async () => {
    const current = stateRef.current.workspace
    try { await storageRef.current.clearPreviews(current.user_id, current.id); return true }
    catch (failure) { setError(failure); return false }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadWorkspace({ userId: userKey, sessionId, initialParams })
    return () => { mountedRef.current = false; clearTimeout(timerRef.current) }
    // Identity is the trigger. Session switches are explicit UI operations; do
    // not reload when an autosave changes state or the callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey])

  useEffect(() => {
    if (!globalThis.BroadcastChannel) return undefined
    const channel = new BroadcastChannel(`chroma-workspaces:${userKey}`)
    channelRef.current = channel
    channel.onmessage = ({ data }) => {
      const current = stateRef.current.workspace
      if (data?.client_id === clientIdRef.current || data?.user_id !== current.user_id
        || data.workspace_id !== current.id || data.revision <= current.revision) return
      clearTimeout(timerRef.current)
      const details = { workspace_id: current.id, revision: data.revision }
      conflictRef.current = details; setConflict(details); setSaveStatus('conflict')
    }
    return () => { channel.close(); if (channelRef.current === channel) channelRef.current = null }
  }, [userKey])

  useEffect(() => {
    const persist = () => { void flush() }
    globalThis.addEventListener?.('pagehide', persist)
    return () => globalThis.removeEventListener?.('pagehide', persist)
  }, [flush])

  // While account identity changes, never render a previous owner's draft.
  const workspace = state.workspace.user_id === userKey ? state.workspace : createWorkspace({ userId: userKey, initialParams, sessionId })
  return { workspace, histories: { past: state.workspace.user_id === userKey ? state.past : [], future: state.workspace.user_id === userKey ? state.future : [] },
    ready: ready && state.workspace.user_id === userKey, saveStatus, error, conflict,
    canUndo: state.workspace.user_id === userKey && state.past.length > 0,
    canRedo: state.workspace.user_id === userKey && state.future.length > 0,
    begin, update, commit, cancel, undo, redo, setMeta, loadWorkspace, fork, flush, backup,
    setGoal, setLocks, setPurpose, reset, applyRecipe, restoreVersion, confirmRecipeInput, confirmBaseline,
    cachePreview, getCachedPreview, clearPreviews }
}
