import { defaultParams, normalizeParams } from './lutEngine.js'
import { PARAM_FIELDS, TECHNICAL_FIELDS, STRUCTURED_FIELDS, clone, equalValue, domainError, validateParams,
  validateRecipe, inputContract, createProjection, recordStyleContribution,
  resetProjection, defaultPurpose, applyStyleRecipe } from './styleRecipe.js'

export const WORKSPACE_FORMAT_VERSION = 1
export const HISTORY_LIMIT = 100
export const GOAL_MODES = Object.freeze(['natural', 'preserve', 'style_only'])
export const PURPOSES = Object.freeze(['default', 'technical', 'correction', 'style', 'unclassified'])
const UNKNOWN_FIELDS = PARAM_FIELDS.filter((field) => !TECHNICAL_FIELDS.includes(field))
const AUTO_READONLY_FIELDS = [...TECHNICAL_FIELDS, ...STRUCTURED_FIELDS]
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNAPSHOT_FIELDS = ['params', 'goal_mode', 'locked_fields', 'name', 'purpose', 'baseline',
  'recipe_projection', 'input_status', 'associated_version', 'validation', 'report']

export function workspaceId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createWorkspace({ id = workspaceId(), userId = 'guest', sessionId = null,
  params, initialParams, legacy = false, name = '', unknown = legacy, ...meta } = {}) {
  if (params || initialParams) validateParams(params || initialParams, { complete: false })
  const values = normalizeParams(params || initialParams || defaultParams())
  validateParams(values)
  return { format_version: WORKSPACE_FORMAT_VERSION, id, user_id: String(userId ?? 'guest'),
    session_id: sessionId, revision: 0, params: values, goal_mode: legacy ? 'natural' : 'preserve',
    locked_fields: [], name, purpose: 'default', baseline: { params: clone(values),
      classification: unknown ? 'unclassified' : 'known', unknown_fields: unknown ? [...UNKNOWN_FIELDS] : [],
      correction_operations: {} }, recipe_projection: createProjection(values), input_status: 'confirmed',
    samples: [], primary_sample_id: null, validation: null, report: null, associated_version: null,
    applied_auto_job_ids: [],
    created_at: Date.now(), updated_at: Date.now(), ...sanitizeMeta(meta) }
}

export function editSnapshot(workspace) {
  return Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, clone(key === 'report' ? workspace[key] ?? null : workspace[key])]))
}

export function createWorkspaceState(options = {}) {
  return { workspace: options.workspace || createWorkspace(options), past: [], future: [], pending: null }
}

export function changedFields(before, after) {
  return PARAM_FIELDS.filter((field) => !equalValue(before[field], after[field]))
}

export function lockConflicts(before, after, lockedFields) {
  return lockedFields.filter((field) => !equalValue(before[field], after[field]))
}

function resolveParams(params, patch) {
  const values = typeof patch === 'function' ? patch(clone(params)) : patch
  if (!values) return clone(params)
  validateParams(values, { complete: false })
  const candidate = { ...clone(params), ...clone(values) }
  validateParams(candidate)
  return candidate
}

function validateLocks(fields) {
  if (!Array.isArray(fields) || fields.some((key) => !PARAM_FIELDS.includes(key))) throw domainError('invalid_locks', '保护字段不正确')
  return [...new Set(fields)]
}

function validatedJobIds(ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)))
    throw domainError('invalid_job_ledger', '自动作业应用标记不正确')
  return [...new Set(ids.map(id => id.toLowerCase()))].slice(-200)
}

function migrateParameterSnapshot(params) {
  validateParams(params, { complete: false })
  const values = clone(params), defaults = defaultParams()
  for (const field of STRUCTURED_FIELDS) if (!Object.hasOwn(values, field)) values[field] = clone(defaults[field])
  validateParams(values)
  return values
}

function migrateSnapshot(snapshot) {
  snapshot.params = migrateParameterSnapshot(snapshot.params)
  if (snapshot.baseline?.params) snapshot.baseline.params = migrateParameterSnapshot(snapshot.baseline.params)
  snapshot.report ??= null
  return snapshot
}

function validateSnapshot(snapshot) {
  validateParams(snapshot.params)
  if (!GOAL_MODES.includes(snapshot.goal_mode) || !PURPOSES.includes(snapshot.purpose)) throw domainError('invalid_context', '工作区目标或用途不正确')
  validateLocks(snapshot.locked_fields)
  if (typeof snapshot.name !== 'string' || !['confirmed', 'pending_confirmation'].includes(snapshot.input_status)) throw domainError('invalid_context', '工作区上下文不正确')
  validateParams(snapshot.baseline?.params)
  if (!['known', 'unclassified'].includes(snapshot.baseline?.classification)
    || !Array.isArray(snapshot.baseline?.unknown_fields)
    || snapshot.baseline.unknown_fields.some((key) => !PARAM_FIELDS.includes(key))) throw domainError('invalid_source', '来源基线不正确')
  const projection = snapshot.recipe_projection
  validateRecipe({ format_version: projection?.format_version, kind: 'portable_style',
    input_contract: projection?.input_contract, operations: projection?.operations }, { allowEmpty: true })
  if (!Array.isArray(projection.contributions) || !Array.isArray(projection.applied_recipes)) throw domainError('invalid_source', '来源投影不正确')
  for (const item of projection.contributions) {
    if (!item || item.purpose !== 'style' || typeof item.before !== 'object' || typeof item.after !== 'object'
      || !item.dependencies || typeof item.dependencies !== 'object') throw domainError('invalid_source', '风格贡献格式不正确')
    validateParams(item.before, { complete: false })
    validateParams(item.after, { complete: false })
    validateParams(item.dependencies, { complete: false })
  }
  return snapshot
}

export function beginEdit(state, options = {}) {
  if (state.pending) return state
  return { ...state, pending: { before: editSnapshot(state.workspace), options: clone(options), id: workspaceId() } }
}

export function previewEdit(state, patch, options = {}) {
  const active = state.pending ? state : beginEdit(state, options)
  const params = resolveParams(active.workspace.params, patch)
  const conflicts = lockConflicts(active.pending.before.params, params, active.pending.before.locked_fields)
  if (conflicts.length) throw domainError('locked_fields', '受保护参数不能修改', conflicts)
  return { ...active, workspace: { ...active.workspace, params } }
}

export function cancelEdit(state) {
  if (!state.pending) return state
  return { ...state, workspace: { ...state.workspace, ...clone(state.pending.before), updated_at: Date.now() }, pending: null }
}

function addCorrection(baseline, before, after, fields) {
  const next = clone(baseline)
  for (const field of fields) {
    if (STRUCTURED_FIELDS.includes(field)) {
      next.correction_operations[field] = { mode: 'set', value: clone(after[field]) }
      continue
    }
    const delta = Array.isArray(after[field]) ? after[field].map((value, i) => value - before[field][i]) : after[field] - before[field]
    const previous = next.correction_operations[field]?.value || (Array.isArray(delta) ? [0, 0, 0] : 0)
    next.correction_operations[field] = { mode: 'add', value: Array.isArray(delta) ? delta.map((value, i) => value + previous[i]) : delta + previous }
  }
  return next
}

function applyPhase(snapshot, before, after, phase, id) {
  const fields = changedFields(before, after)
  const styleFields = fields.filter((field) => !TECHNICAL_FIELDS.includes(field)
    && (phase.purpose === 'style' || ((!phase.purpose || phase.purpose === 'default') && defaultPurpose(field) === 'style')))
  const correctionFields = fields.filter((field) => !TECHNICAL_FIELDS.includes(field)
    && (phase.purpose === 'correction' || ((!phase.purpose || phase.purpose === 'default') && defaultPurpose(field) === 'correction')))
  if (styleFields.length) {
    const styleAfter = clone(before)
    for (const field of styleFields) styleAfter[field] = clone(after[field])
    // Anchors are captured from the actual effective stage, including any changes
    // made for a different purpose in the same user action.
    for (const field of PARAM_FIELDS) if (!styleFields.includes(field)) styleAfter[field] = clone(after[field])
    const styleBefore = clone(styleAfter)
    for (const field of styleFields) styleBefore[field] = clone(before[field])
    snapshot.recipe_projection = recordStyleContribution(snapshot.recipe_projection, styleBefore, styleAfter,
      { id, source: phase.source, modes: phase.modes })
  }
  if (correctionFields.length) {
    snapshot.baseline = addCorrection(snapshot.baseline, before, after, correctionFields)
    if (Object.keys(snapshot.recipe_projection.operations).length) snapshot.recipe_projection.corrections_after_style = true
  }
}

export function commitEdit(state, patch, options = {}) {
  const pending = state.pending
  const before = pending?.before || editSnapshot(state.workspace)
  const config = { ...(pending?.options || {}), ...options }
  const id = config.id ?? pending?.id ?? workspaceId()
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw domainError('invalid_transaction', '操作标识不正确')
  const after = editSnapshot(state.workspace)
  after.params = resolveParams(after.params, patch)
  if (config.context) {
    for (const key of ['goal_mode', 'locked_fields', 'name', 'purpose']) {
      if (key in config.context) after[key] = clone(config.context[key])
    }
  }
  const unlocked = validateLocks(config.unlockFields || [])
  after.locked_fields = validateLocks(after.locked_fields).filter((field) => !unlocked.includes(field))
  if (config.restoreSnapshot) {
    const restored = config.restoreSnapshot
    for (const key of SNAPSHOT_FIELDS.filter((key) => key !== 'locked_fields')) {
      if (key in restored) after[key] = clone(restored[key])
    }
  }
  if (config.resetFields) {
    const defaults = defaultParams()
    const fields = validateLocks(config.resetFields).filter((field) => !before.locked_fields.includes(field))
    for (const field of fields) {
      after.params[field] = clone(defaults[field])
      after.baseline.params[field] = clone(defaults[field])
      delete after.baseline.correction_operations[field]
    }
    after.baseline.unknown_fields = after.baseline.unknown_fields.filter((field) => !fields.includes(field))
    if (!after.baseline.unknown_fields.length) after.baseline.classification = 'known'
    after.recipe_projection = resetProjection(after.recipe_projection, fields, after.params)
  }
  const conflicts = lockConflicts(before.params, after.params, before.locked_fields.filter((field) => !unlocked.includes(field)))
  if (conflicts.length) throw domainError('locked_fields', '修改与受保护参数冲突', conflicts)
  if (config.source === 'auto' && AUTO_READONLY_FIELDS.some((field) => !equalValue(before.params[field], after.params[field]))) {
    throw domainError('technical_readonly', '自动修图不能更改输入、曲线或外部 LUT', AUTO_READONLY_FIELDS)
  }
  validateParams(after.params)
  if (config.replaceBaseline) {
    after.baseline = { params: clone(after.params), classification: 'unclassified', unknown_fields: [...UNKNOWN_FIELDS], correction_operations: {} }
    after.recipe_projection = createProjection(after.params)
    after.input_status = 'confirmed'
  } else if (!config.restoreSnapshot && !config.resetFields) {
    const phases = config.phases?.filter((phase) => phase.applied !== false) || []
    if (phases.length) {
      let current = before.params
      for (const phase of phases) {
        const rawBefore = phase.before_params || phase.before || current
        const rawAfter = phase.after_params || phase.after || phase.params || current
        validateParams(rawBefore, { complete: false }); validateParams(rawAfter, { complete: false })
        const phaseBefore = normalizeParams(rawBefore)
        const phaseAfter = normalizeParams(rawAfter)
        validateParams(phaseBefore); validateParams(phaseAfter)
        if (!equalValue(phaseBefore, current)) throw domainError('invalid_phases', '调整来源阶段不连续')
        const phaseConflicts = lockConflicts(before.params, phaseAfter, before.locked_fields.filter((field) => !unlocked.includes(field)))
        if (phaseConflicts.length) throw domainError('locked_fields', '调整阶段修改了受保护参数', phaseConflicts)
        if (config.source === 'auto' && AUTO_READONLY_FIELDS.some(field => !equalValue(before.params[field], phaseAfter[field])))
          throw domainError('technical_readonly', '自动阶段不能更改输入、曲线或外部 LUT', AUTO_READONLY_FIELDS)
        applyPhase(after, phaseBefore, phaseAfter, phase, id)
        current = phaseAfter
      }
      if (!equalValue(current, after.params)) throw domainError('invalid_phases', '调整来源与最终参数不一致')
    } else applyPhase(after, before.params, after.params, { purpose: config.purpose || before.purpose, source: config.source || 'manual', modes: config.modes }, id)
    const technicalChanged = TECHNICAL_FIELDS.some((field) => !equalValue(before.params[field], after.params[field]))
    if (technicalChanged) after.input_status = 'pending_confirmation'
  }
  if (config.confirmInput) {
    after.recipe_projection.input_contract = inputContract(after.params)
    after.input_status = 'confirmed'
  }
  if (config.confirmBaselineFields) {
    const fields = validateLocks(config.confirmBaselineFields).filter((field) => !TECHNICAL_FIELDS.includes(field))
    const neutral = defaultParams()
    const sourceBefore = clone(after.params)
    for (const field of fields) sourceBefore[field] = clone(neutral[field])
    after.recipe_projection = recordStyleContribution(after.recipe_projection, sourceBefore, after.params,
      { id, source: 'baseline_confirmation', forceFields: fields,
        modes: Object.fromEntries(fields.map((field) => [field, 'set'])) })
    after.baseline.classification = 'known'
    after.baseline.unknown_fields = []
  }
  if (config.recipeIdentity) after.recipe_projection.applied_recipes.push(config.recipeIdentity)
  const paramsChanged = !equalValue(before.params, after.params)
  if (paramsChanged && after.validation) after.validation = { ...after.validation, stale: true }
  validateSnapshot(after)
  // A report follows a real editing transaction; failed or skipped automatic
  // attempts remain metadata and cannot create an undo step on their own.
  if (!SNAPSHOT_FIELDS.some((key) => key !== 'report' && !equalValue(before[key], after[key]))) return { ...state, pending: null }
  if ([...state.past, ...state.future].some(transaction => transaction.id === id))
    throw domainError('duplicate_transaction', '此作业操作已经存在，不能重复应用')
  if (Object.hasOwn(config, 'report')) {
    const report = jsonMetadata(config.report)
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw domainError('invalid_report', '事务报告必须是对象')
    after.report = { ...report, transaction_id: id }
  }
  const transaction = { id, source: config.source || 'manual', label: config.label || '',
    purpose: config.purpose || before.purpose, before: clone(before), after: clone(after),
    phases: clone(config.phases || []), report_ref: config.reportRef || null, created_at: Date.now() }
  return { workspace: { ...state.workspace, ...after, updated_at: Date.now() },
    past: [...state.past, transaction].slice(-HISTORY_LIMIT), future: [], pending: null }
}

export function undoEdit(state) {
  const committed = state.pending ? commitEdit(state) : state
  const transaction = committed.past.at(-1)
  if (!transaction) return committed
  return { workspace: { ...committed.workspace, ...clone(transaction.before), updated_at: Date.now() },
    past: committed.past.slice(0, -1), future: [transaction, ...committed.future], pending: null }
}

export function redoEdit(state) {
  const transaction = state.future[0]
  if (!transaction) return state
  return { workspace: { ...state.workspace, ...clone(transaction.after), updated_at: Date.now() },
    past: [...state.past, transaction].slice(-HISTORY_LIMIT), future: state.future.slice(1), pending: null }
}

export function applyRecipeEdit(state, recipe, { unlockFields = [], allowRepeat = false } = {}) {
  // Asset identity is editing metadata, separate from the strict portable recipe.
  const { id: assetId, revision: assetRevision, ...portableRecipe } = recipe
  const identity = String(assetId || recipe.source?.asset_id || '') + ':' + String(assetRevision || recipe.source?.revision || JSON.stringify(recipe.operations))
  if (!allowRepeat && state.workspace.recipe_projection.applied_recipes.includes(identity)) throw domainError('repeat_recipe', '此风格已经追加过，再次追加会累积')
  const params = applyStyleRecipe(portableRecipe, state.workspace.params,
    { lockedFields: state.workspace.locked_fields.filter((field) => !unlockFields.includes(field)) })
  return commitEdit(state, params, { source: 'recipe', purpose: 'style', unlockFields, recipeIdentity: identity,
    modes: Object.fromEntries(Object.entries(recipe.operations).filter(([, operation]) => !operation.dependency).map(([field, operation]) => [field, operation.mode])) })
}

export function restoreVersionEdit(state, version, { unlockFields = [], confirmInput = false } = {}) {
  const saved = version.source?.workspace_snapshot || version.workspace_snapshot || version
  validateParams(version.params || saved.params, { complete: false })
  const params = normalizeParams(version.params || saved.params)
  const changesInput = !equalValue(inputContract(params), inputContract(state.workspace.params))
  if (changesInput && !confirmInput) throw domainError('input_confirmation', '恢复此版本需要确认输入切换', TECHNICAL_FIELDS)
  const snapshot = { ...editSnapshot(state.workspace), ...clone(saved), params,
    locked_fields: state.workspace.locked_fields, associated_version: version.id || saved.associated_version || null }
  if (!saved.baseline || !saved.recipe_projection) {
    snapshot.baseline = { params: clone(params), classification: 'unclassified', unknown_fields: [...UNKNOWN_FIELDS], correction_operations: {} }
    snapshot.recipe_projection = createProjection(params)
    snapshot.input_status = 'confirmed'
  }
  migrateSnapshot(snapshot)
  return commitEdit(state, null, { source: 'version_restore', restoreSnapshot: snapshot, unlockFields })
}

function jsonMetadata(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value)) return value.map(jsonMetadata).filter((item) => item !== undefined)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['file', 'blob', 'canvas', 'preview_blob', 'source_file', 'image', 'data_url'].includes(key))
      .map(([key, item]) => [key, jsonMetadata(item)]).filter(([, item]) => item !== undefined))
  }
  return undefined
}

export function sanitizeMeta(meta) {
  const allowed = ['samples', 'primary_sample_id', 'validation', 'report', 'session_id', 'name', 'purpose',
    'view_state', 'retain_previews', 'associated_version', 'applied_auto_job_ids']
  return Object.fromEntries(allowed.filter((key) => key in meta).map((key) => [key,
    key === 'applied_auto_job_ids' ? validatedJobIds(meta[key]) : jsonMetadata(meta[key])]))
}

export function setWorkspaceMeta(state, meta) {
  const next = { ...state, workspace: { ...state.workspace, ...sanitizeMeta(meta), updated_at: Date.now() } }
  if (typeof next.workspace.name !== 'string' || !PURPOSES.includes(next.workspace.purpose)) throw domainError('invalid_context', '工作区名称或用途不正确')
  return next
}

export function serializeWorkspaceState(state) {
  // A reload during a drag recovers the visible adjustment as one undoable action.
  const committed = state.pending ? commitEdit(state) : state
  return { format_version: WORKSPACE_FORMAT_VERSION, workspace: jsonMetadata(committed.workspace),
    past: jsonMetadata(committed.past), future: jsonMetadata(committed.future) }
}

export function validateWorkspaceRecord(record, userId) {
  if (!record?.workspace || record.workspace.user_id !== String(userId ?? 'guest')) throw domainError('invalid_owner', '草稿不属于当前账号')
  const workspace = clone(record.workspace)
  migrateSnapshot(workspace)
  workspace.applied_auto_job_ids = validatedJobIds(workspace.applied_auto_job_ids ?? [])
  validateSnapshot(workspace)
  if (typeof workspace.id !== 'string' || !Number.isInteger(workspace.revision) || workspace.revision < 0) throw domainError('invalid_draft', '草稿标识或修订不正确')
  let historyWarning = null
  let past = []; let future = []
  if (record.format_version === WORKSPACE_FORMAT_VERSION && workspace.format_version === WORKSPACE_FORMAT_VERSION) {
    try {
      if (!Array.isArray(record.past) || !Array.isArray(record.future)) throw new Error('missing history')
      const restoredPast = clone(record.past); const restoredFuture = clone(record.future)
      for (const transaction of [...restoredPast, ...restoredFuture]) {
        if (transaction.before) migrateSnapshot(transaction.before)
        if (transaction.after) migrateSnapshot(transaction.after)
        validateSnapshot(transaction.before); validateSnapshot(transaction.after)
        if (typeof transaction.id !== 'string') throw new Error('invalid transaction')
      }
      past = restoredPast.slice(-HISTORY_LIMIT); future = restoredFuture.slice(0, HISTORY_LIMIT)
    } catch { historyWarning = '操作历史格式不兼容，已保留当前有效参数' }
  } else historyWarning = '草稿格式版本已变化，操作历史已失效'
  workspace.samples = (workspace.samples || []).map((sample) => ({ ...sample, needs_rebind: true, origin: 'restored_preview' }))
  return { workspace, past, future, pending: null, historyWarning }
}
