import { useCallback, useEffect, useRef, useState } from 'react'
import { createWorkspace, createWorkspaceState, beginEdit, previewEdit, commitEdit, cancelEdit, undoEdit, redoEdit,
  setWorkspaceMeta, serializeWorkspaceState, validateWorkspaceRecord, applyRecipeEdit, restoreVersionEdit,
  workspaceId, historyAvailability } from '../lib/workspace.js'
import { createDraftStorage, draftBackup } from '../lib/draftStorage.js'
import { createAutoJobStorage } from '../lib/autoJobStorage.js'
import { duplicateWorkspaceState, renameWorkspaceState, projectName, retireLocalProject } from '../lib/projectManagement.js'
import { clone, domainError, inputContract } from '../lib/styleRecipe.js'

export default function useWorkspace({ userId = 'guest', initialParams, sessionId = null, storage, jobStorage } = {}) {
  const userKey = String(userId ?? 'guest')
  const [state, setState] = useState(() => createWorkspaceState({ userId: userKey, initialParams, sessionId }))
  const stateRef = useRef(state)
  const storageRef = useRef(storage || createDraftStorage())
  const jobStorageRef = useRef(jobStorage !== undefined ? jobStorage : globalThis.indexedDB ? createAutoJobStorage() : null)
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
  const retiredRef = useRef(new Set())
  const loadWorkspaceRef = useRef(null)
  const retiredKey = (owner, id) => JSON.stringify([String(owner), id])

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
      if (conflictRef.current || retiredRef.current.has(retiredKey(requestedUser, requestedId))) return null
      const current = stateRef.current
      if (current.workspace.id !== requestedId || current.workspace.user_id !== requestedUser) return null
      const sequence = sequenceRef.current
      if (mountedRef.current) setSaveStatus('saving')
      try {
        const record = serializeWorkspaceState(current)
        const saved = await storageRef.current.save(requestedUser, record, current.workspace.revision)
        if (retiredRef.current.has(retiredKey(requestedUser, requestedId))) return null
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
      } catch (failure) {
        if (!retiredRef.current.has(retiredKey(requestedUser, requestedId)) && stateRef.current.workspace.id === requestedId) showError(failure)
        return null
      }
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
      const current = stateRef.current.workspace
      if (retiredRef.current.has(retiredKey(current.user_id, current.id))) throw domainError('project_deleted', '此调色项目已删除，请切换到其他项目')
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
    if (options.isCurrent && !options.isCurrent()) return null
    clearTimeout(timerRef.current)
    const generation = ++loadGenerationRef.current
    const current = stateRef.current
    const owner = String(options.userId ?? userKey)
    const requestedId = options.id || options.workspace?.id
    const reloadingConflict = Boolean(conflictRef.current && requestedId === current.workspace.id)
    if (current.workspace.user_id === owner && ready && !reloadingConflict && !retiredRef.current.has(retiredKey(owner, current.workspace.id)) && sequenceRef.current > 0) {
      const saved = await flush()
      if (!saved) return null
    }
    setReady(false); setSaveStatus('loading')
    try {
      if (requestedId && (retiredRef.current.has(retiredKey(owner, requestedId)) || await storageRef.current.isDeleted?.(owner, requestedId))) {
        retiredRef.current.add(retiredKey(owner, requestedId))
        throw domainError('project_deleted', '此调色项目已删除，请选择其他项目')
      }
      let record = options.workspace ? options : requestedId
        ? await storageRef.current.load(owner, requestedId)
        : await storageRef.current.latest(owner, options.sessionId ?? sessionId)
      if (generation !== loadGenerationRef.current) return null
      if (options.isCurrent && !options.isCurrent()) { setReady(true); return null }
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
      if (options.isCurrent && !options.isCurrent()) { setReady(true); return null }
      showError(failure)
      // Failed storage does not discard a valid current workspace. An account
      // switch must still hide the previous owner's in-memory draft.
      if (stateRef.current.workspace.user_id !== owner || retiredRef.current.has(retiredKey(owner, stateRef.current.workspace.id))) {
        const next = createWorkspaceState({ userId: owner, initialParams, sessionId: null })
        stateRef.current = next; setState(next); sequenceRef.current = 1
        schedule()
      }
      setReady(true)
      return null
    }
  }, [userKey, sessionId, initialParams, flush, ready, schedule, showError])

  loadWorkspaceRef.current = loadWorkspace

  const listProjects = useCallback(async () => {
    try { return (await storageRef.current.list(userKey)).map(record => clone(record.workspace)) }
    catch (failure) { showError(failure); return null }
  }, [showError, userKey])
  const deletedProjectIds = useCallback(async () => storageRef.current.deletedIds?.(userKey) || [], [userKey])

  const renameProject = useCallback(async (value, id = stateRef.current.workspace.id) => {
    const owner = userKey
    try {
      const name = projectName(value)
      if (retiredRef.current.has(retiredKey(owner, id)) || await storageRef.current.isDeleted?.(owner, id))
        throw domainError('project_deleted', '此调色项目已删除，不能重命名')
      if (stateRef.current.workspace.id !== id) {
        const record = await storageRef.current.load(owner, id)
        if (!record) return { id, name }
        const next = renameWorkspaceState(validateWorkspaceRecord(record, owner), name)
        next.workspace.samples = clone(record.workspace.samples || [])
        const saved = await storageRef.current.save(owner, serializeWorkspaceState(next), next.workspace.revision)
        channelRef.current?.postMessage({ user_id: owner, workspace_id: id, revision: saved.workspace.revision, client_id: clientIdRef.current })
        return saved.workspace
      }
      if (stateRef.current.workspace.user_id !== owner) throw domainError('invalid_owner', '不能重命名其他账号的项目')
      publish(renameWorkspaceState(stateRef.current, name))
      const saved = await flush()
      return saved?.workspace || null
    } catch (failure) {
      if (stateRef.current.workspace.id === id) showError(failure)
      else setError(failure)
      return null
    }
  }, [flush, publish, showError, userKey])

  const duplicateProject = useCallback(async (options = {}) => {
    clearTimeout(timerRef.current)
    const sourceId = stateRef.current.workspace.id
    const owner = stateRef.current.workspace.user_id
    let next = null
    let copySaved = false
    let copyStarted = false
    try {
      if (!(await flush())) return null
      next = duplicateWorkspaceState(stateRef.current, options)
      if (next.workspace.user_id !== userKey || stateRef.current.workspace.id !== sourceId)
        throw domainError('project_changed', '当前项目已切换，请重新复制')
      if (await storageRef.current.load(owner, next.workspace.id) || await storageRef.current.hasPreviews?.(owner, next.workspace.id))
        throw domainError('project_exists', '副本项目标识已被使用，请重新复制')
      copyStarted = true
      await storageRef.current.copyPreviews?.(owner, sourceId, next.workspace.id, next.workspace.samples.map(sample => sample.id))
      const saved = await storageRef.current.save(owner, serializeWorkspaceState(next), 0)
      copySaved = true
      // A copy becomes current only after its complete draft has been saved.
      if (stateRef.current.workspace.id !== sourceId || retiredRef.current.has(retiredKey(owner, sourceId))) return saved.workspace
      conflictRef.current = null; setConflict(null)
      stateRef.current = { ...next, workspace: saved.workspace }
      sequenceRef.current = 0
      setState(stateRef.current); setError(null); setSaveStatus('saved'); setReady(true)
      return saved.workspace
    } catch (failure) {
      if (next && copyStarted && !copySaved) {
        try {
          if (!(await storageRef.current.load(owner, next.workspace.id)))
            await storageRef.current.clearPreviews(owner, next.workspace.id)
        } catch (cleanupFailure) { failure.cleanupFailure = cleanupFailure }
      }
      showError(failure); return null
    }
  }, [flush, showError, userKey])

  const notifyProjectDeletion = useCallback((id, replacementId = null) => {
    channelRef.current?.postMessage({ user_id: userKey, workspace_id: id, deleted: true,
      ...(replacementId && replacementId !== id ? { replacement_id: replacementId } : {}), client_id: clientIdRef.current })
  }, [userKey])

  const retireProject = useCallback(async (id = stateRef.current.workspace.id, { broadcast = true } = {}) => {
    const owner = userKey
    retiredRef.current.add(retiredKey(owner, id))
    if (stateRef.current.workspace.id === id) {
      clearTimeout(timerRef.current)
      ++loadGenerationRef.current
      conflictRef.current = null; setConflict(null); setReady(false)
    }
    try {
      await retireLocalProject({ draftStorage: storageRef.current, jobStorage: jobStorageRef.current, userId: owner, id })
      return true
    } catch (failure) {
      showError(failure)
      return false
    } finally {
      if (broadcast) notifyProjectDeletion(id)
    }
  }, [notifyProjectDeletion, showError, userKey])

  const fork = useCallback(async () => {
    clearTimeout(timerRef.current)
    try {
      const current = stateRef.current.pending ? commitEdit(stateRef.current) : stateRef.current
      const next = duplicateWorkspaceState(current, { sessionId: current.workspace.session_id })
      await storageRef.current.copyPreviews?.(current.workspace.user_id, current.workspace.id, next.workspace.id, next.workspace.samples.map(sample => sample.id))
      conflictRef.current = null; setConflict(null)
      publish(next)
      const saved = await flush()
      return saved?.workspace || null
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
      if (data?.client_id === clientIdRef.current || data?.user_id !== current.user_id) return
      if (data.deleted) {
        retiredRef.current.add(retiredKey(current.user_id, data.workspace_id))
        if (data.workspace_id === current.id) {
          clearTimeout(timerRef.current); ++loadGenerationRef.current
          conflictRef.current = null; setConflict(null); setReady(false)
          void retireLocalProject({ draftStorage: storageRef.current, jobStorage: jobStorageRef.current, userId: current.user_id, id: current.id }).catch(showError)
            .then(() => {
              if (stateRef.current.workspace.id !== current.id || stateRef.current.workspace.user_id !== current.user_id) return null
              const replacementId = typeof data.replacement_id === 'string' && data.replacement_id !== current.id ? data.replacement_id : null
              return loadWorkspaceRef.current?.({ userId: current.user_id, sessionId: null, ...(replacementId ? { id: replacementId } : {}) })
            })
        }
        return
      }
      if (data.workspace_id !== current.id || data.revision <= current.revision) return
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
  const owned = state.workspace.user_id === userKey
  const workspace = owned ? state.workspace : createWorkspace({ userId: userKey, initialParams, sessionId })
  const history = owned ? historyAvailability(state) : { canUndo: false, canRedo: false }
  return { workspace, histories: { past: owned ? state.past : [], future: owned ? state.future : [] },
    ready: ready && owned, saveStatus, error, conflict,
    ...history,
    begin, update, commit, cancel, undo, redo, setMeta, loadWorkspace, fork, flush, backup,
    listProjects, deletedProjectIds, renameProject, duplicateProject, retireProject, notifyProjectDeletion,
    setGoal, setLocks, setPurpose, reset, applyRecipe, restoreVersion, confirmRecipeInput, confirmBaseline,
    cachePreview, getCachedPreview, clearPreviews }
}
