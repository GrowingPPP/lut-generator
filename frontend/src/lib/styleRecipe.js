import { defaultParams, normalizeParams } from './lutEngine.js'
import { validateCurvePoints } from './curveMath.js'
import { validateExternalId, validateExternalOptions } from './cubeLut.js'

export const PARAM_FIELDS = Object.freeze(Object.keys(defaultParams()))
export const TECHNICAL_FIELDS = Object.freeze(['base_photo_style', 'tone_map'])
export const EXTERNAL_FIELDS = Object.freeze(['external_lut_id', 'external_lut_strength', 'external_lut_mode'])
export const STRUCTURED_FIELDS = Object.freeze(['curve_points', ...EXTERNAL_FIELDS])
export const PARAM_RANGES = Object.freeze({
  temp: [-3000, 3000], tint: [-500, 500], exposure: [-3, 3], contrast: [-1, 1],
  contrast_pivot: [0.1, 0.9], saturation: [-1, 1], hue: [-180, 180], vibrance: [-1, 1],
  tone_map: [0, 1], look_strength: [0, 1], highlights: [-1, 1], shadows: [-1, 1],
  whites: [-1, 1], blacks: [-1, 1], curve: [-1, 1], split_shadow_hue: [0, 360],
  split_shadow_sat: [0, 1], split_highlight_hue: [0, 360], split_highlight_sat: [0, 1],
  split_mid_hue: [0, 360], split_mid_sat: [0, 1], split_balance: [0, 1],
  selective_hue_center: [0, 360], selective_hue_width: [1, 180],
  selective_hue_shift: [-180, 180], selective_saturation: [-1, 1],
  lift: [-0.1, 0.1], gamma: [0.5, 1.5], gain: [0.5, 1.5],
  external_lut_strength: [0, 1],
})
export const DEPENDENCIES = Object.freeze({
  contrast: ['contrast_pivot'],
  selective_hue_shift: ['selective_hue_center', 'selective_hue_width'],
  selective_saturation: ['selective_hue_center', 'selective_hue_width'],
  split_shadow_sat: ['split_shadow_hue', 'split_balance'],
  split_highlight_sat: ['split_highlight_hue', 'split_balance'],
  split_mid_sat: ['split_mid_hue', 'split_balance'],
  external_lut_id: ['external_lut_strength', 'external_lut_mode'],
  external_lut_strength: ['external_lut_id', 'external_lut_mode'],
  external_lut_mode: ['external_lut_id', 'external_lut_strength'],
})
const SET_FIELDS = new Set(['contrast_pivot', 'selective_hue_center', 'selective_hue_width',
  'split_shadow_hue', 'split_highlight_hue', 'split_mid_hue', 'split_balance', 'look_strength', ...STRUCTURED_FIELDS])
const BASIC_FIELDS = new Set(['temp', 'tint', 'exposure'])
export const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value))
export function equalValue(a, b) {
  if (a === b) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalValue(a[key], b[key]))
}
export function wrapHue(value) {
  const shifted = (value + 180) % 360
  return (shifted < 0 ? shifted + 360 : shifted) - 180
}

export function domainError(code, message, fields = []) {
  const error = new Error(message)
  error.code = code
  error.fields = fields
  return error
}

export function validateParams(params, { complete = true } = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw domainError('invalid_params', '参数格式不正确')
  }
  const invalid = Object.keys(params).filter((key) => !PARAM_FIELDS.includes(key))
  if (complete) invalid.push(...PARAM_FIELDS.filter((key) => !(key in params)))
  const defaults = defaultParams()
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM_FIELDS.includes(key)) continue
    if (key === 'base_photo_style') {
      if (!['STD', 'NAT', 'VIVD', 'VLOG'].includes(value)) invalid.push(key)
      continue
    }
    if (STRUCTURED_FIELDS.includes(key)) {
      try {
        if (key === 'curve_points') validateCurvePoints(value)
        else if (key === 'external_lut_id') validateExternalId(value)
        else if (key === 'external_lut_mode' && !['display', 'input'].includes(value)) throw new Error()
        else if (key === 'external_lut_strength' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error()
      } catch { invalid.push(key) }
      continue
    }
    const values = Array.isArray(defaults[key]) ? value : [value]
    if (!Array.isArray(values) || (Array.isArray(defaults[key]) && values.length !== 3)) {
      invalid.push(key)
      continue
    }
    const [low, high] = PARAM_RANGES[key]
    if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high)) invalid.push(key)
  }
  if (complete) {
    try {
      const full = { ...defaults, ...params }
      validateExternalOptions(full.external_lut_id, full.external_lut_strength, full.external_lut_mode, full.base_photo_style)
    } catch { invalid.push(...EXTERNAL_FIELDS) }
  }
  if (invalid.length) throw domainError('invalid_params', '参数非法或超出范围', [...new Set(invalid)])
  return params
}

export function inputContract(params) {
  return { base_photo_style: params.base_photo_style,
    output_encoding: params.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB', tone_map: params.tone_map }
}

export function validateInputContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
    || Object.keys(contract).length !== 3
    || Object.keys(contract).some((key) => !['base_photo_style', 'tone_map', 'output_encoding'].includes(key))
    || !['STD', 'NAT', 'VIVD', 'VLOG'].includes(contract.base_photo_style)
    || contract.output_encoding !== (contract.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB')
    || !Number.isFinite(contract.tone_map) || contract.tone_map < 0 || contract.tone_map > 1) {
    throw domainError('invalid_input', '风格输入契约不正确')
  }
  return contract
}

export function defaultPurpose(field) {
  return TECHNICAL_FIELDS.includes(field) ? 'technical' : BASIC_FIELDS.has(field) ? 'correction' : 'style'
}

export function dependenciesFor(field) {
  const deps = [...(DEPENDENCIES[field] || [])]
  if (!TECHNICAL_FIELDS.includes(field) && !BASIC_FIELDS.has(field) && field !== 'look_strength' && !EXTERNAL_FIELDS.includes(field)) deps.push('look_strength')
  return deps
}

export function createProjection(params) {
  return { format_version: 1, input_contract: inputContract(params), operations: {},
    contributions: [], corrections_after_style: false, applied_recipes: [] }
}

const addValues = (a, b) => Array.isArray(a) ? a.map((value, i) => value + b[i]) : a + b
const difference = (after, before) => Array.isArray(after) ? after.map((value, i) => value - before[i]) : after - before
const isZero = (value) => Array.isArray(value) ? value.every((v) => Math.abs(v) < 1e-12) : Math.abs(value) < 1e-12

export function composeOperation(previous, next) {
  if (!previous || next.mode === 'set') return clone(next)
  return { ...clone(next), mode: previous.mode, value: addValues(previous.value, next.value) }
}

// Field operations are the canonical projection; provenance is self-contained and
// deliberately independent of the bounded undo log.
export function recordStyleContribution(projection, before, after, metadata = {}) {
  const next = clone(projection || createProjection(before))
  const changed = PARAM_FIELDS.filter((field) => !TECHNICAL_FIELDS.includes(field)
    && (!equalValue(before[field], after[field]) || metadata.forceFields?.includes(field)))
  if (!changed.length) return next
  const contribution = { id: metadata.id, source: metadata.source || 'manual', purpose: 'style',
    input_contract: inputContract(before), before: {}, after: {}, dependencies: {} }
  for (const field of changed) {
    const mode = metadata.modes?.[field] || (SET_FIELDS.has(field) ? 'set' : 'add')
    let value = mode === 'set' ? clone(after[field]) : difference(after[field], before[field])
    if (field === 'hue' && mode === 'add') value = wrapHue(value)
    const previous = next.operations[field]
    // An anchor is an absolute position, not an earlier user style operation.
    next.operations[field] = composeOperation(previous, { mode, value })
    contribution.before[field] = clone(before[field])
    contribution.after[field] = clone(after[field])
    for (const dependency of dependenciesFor(field)) {
      contribution.dependencies[dependency] = clone(after[dependency])
      if (!changed.includes(dependency)) next.operations[dependency] = { mode: 'set', value: clone(after[dependency]),
        ...(next.operations[dependency] && !next.operations[dependency].dependency ? {} : { dependency: true }) }
    }
  }
  for (const [field, operation] of Object.entries(next.operations)) {
    if (operation.mode === 'add' && isZero(operation.value)) delete next.operations[field]
  }
  next.operations = pruneDependencies(next.operations)
  next.contributions.push(contribution)
  if (next.contributions.length > 32 || JSON.stringify(next.contributions).length > 8192) {
    next.contributions = [contributionCheckpoint(next)]
  }
  return next
}

function contributionCheckpoint(projection) {
  const before = {}; const after = {}; const dependencies = {}
  let count = 0
  for (const item of projection.contributions) {
    for (const [field, value] of Object.entries(item.before)) if (!(field in before)) before[field] = clone(value)
    Object.assign(after, clone(item.after)); Object.assign(dependencies, clone(item.dependencies))
    count += item.original_transaction_count || 1
  }
  return { id: projection.contributions.at(-1)?.id, source: 'projection_checkpoint', purpose: 'style',
    input_contract: clone(projection.input_contract), before, after, dependencies,
    original_transaction_count: count, compiled_operations: clone(projection.operations) }
}

export function pruneDependencies(operations) {
  const next = clone(operations)
  const needed = new Set(Object.keys(next).filter((key) => !next[key].dependency).flatMap(dependenciesFor))
  for (const [key, operation] of Object.entries(next)) {
    if (operation.dependency && !needed.has(key)) delete next[key]
  }
  return next
}

export function resetProjection(projection, fields, params) {
  const next = clone(projection)
  const reset = new Set(fields)
  for (const field of fields) delete next.operations[field]
  next.contributions = next.contributions.map((entry) => {
    const item = clone(entry)
    for (const field of fields) { delete item.before[field]; delete item.after[field] }
    const needed = new Set(Object.keys(item.after).flatMap(dependenciesFor))
    for (const dependency of Object.keys(item.dependencies)) {
      if (!needed.has(dependency)) delete item.dependencies[dependency]
      else if (reset.has(dependency)) item.dependencies[dependency] = clone(params[dependency])
    }
    return item
  }).filter((entry) => Object.keys(entry.after).length)
  const effects = Object.keys(next.operations).filter((key) => !next.operations[key].dependency)
  for (const field of effects) {
    for (const dependency of dependenciesFor(field)) {
      if (reset.has(dependency) || !next.operations[dependency]) {
        next.operations[dependency] = { mode: 'set', value: clone(params[dependency]), dependency: true }
      }
    }
  }
  next.operations = pruneDependencies(next.operations)
  for (const item of next.contributions) {
    if (item.compiled_operations) item.compiled_operations = clone(next.operations)
  }
  return next
}

export function validateRecipe(recipe, { allowEmpty = false } = {}) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw domainError('invalid_recipe', '配方必须是对象')
  const unknown = Object.keys(recipe).filter((key) => !['format_version', 'schema_version', 'kind', 'input_contract', 'operations', 'source'].includes(key))
  if (unknown.length) throw domainError('invalid_recipe', '配方包含未知字段', unknown)
  const version = Object.hasOwn(recipe, 'format_version') ? recipe.format_version : recipe.schema_version
  if (version !== 1 || (Object.hasOwn(recipe, 'schema_version') && recipe.schema_version !== version)
    || (Object.hasOwn(recipe, 'kind') && recipe.kind !== 'portable_style')) throw domainError('invalid_recipe', '不支持的风格配方格式')
  validateInputContract(recipe.input_contract)
  if (!recipe.operations || typeof recipe.operations !== 'object' || Array.isArray(recipe.operations)) throw domainError('invalid_recipe', '配方操作格式不正确')
  const invalid = []
  const defaults = defaultParams()
  for (const [field, operation] of Object.entries(recipe.operations)) {
    if (!PARAM_FIELDS.includes(field) || TECHNICAL_FIELDS.includes(field) || !operation
      || typeof operation !== 'object' || Array.isArray(operation)
      || Object.keys(operation).some((key) => !['mode', 'value', 'dependency'].includes(key))
      || !['add', 'set'].includes(operation.mode)
      || ('dependency' in operation && typeof operation.dependency !== 'boolean')) { invalid.push(field); continue }
    if (STRUCTURED_FIELDS.includes(field)) {
      if (operation.mode !== 'set') invalid.push(field)
      try {
        if (field === 'curve_points') validateCurvePoints(operation.value)
        else if (field === 'external_lut_id') validateExternalId(operation.value)
        else if (field === 'external_lut_mode' && !['display', 'input'].includes(operation.value)) throw new Error()
        else if (field === 'external_lut_strength' && (typeof operation.value !== 'number' || !Number.isFinite(operation.value) || operation.value < 0 || operation.value > 1)) throw new Error()
      } catch { invalid.push(field) }
    } else {
      const values = Array.isArray(defaults[field]) ? operation.value : [operation.value]
      if (!Array.isArray(values) || (Array.isArray(defaults[field]) && values.length !== 3)
        || values.some((value) => !Number.isFinite(value)) || (operation.dependency && operation.mode !== 'set')) invalid.push(field)
      else if (operation.mode === 'set' && values.some((value) => value < PARAM_RANGES[field][0] || value > PARAM_RANGES[field][1])) invalid.push(field)
    }
    if (!operation.dependency) {
      for (const dependency of dependenciesFor(field)) {
        if (!recipe.operations[dependency] || recipe.operations[dependency].mode !== 'set') invalid.push(dependency)
      }
    }
  }
  if (EXTERNAL_FIELDS.some(field => Object.hasOwn(recipe.operations, field))) {
    try { validateExternalOptions(recipe.operations.external_lut_id?.value, recipe.operations.external_lut_strength?.value,
      recipe.operations.external_lut_mode?.value, recipe.input_contract.base_photo_style) }
    catch { invalid.push(...EXTERNAL_FIELDS) }
  }
  if (invalid.length) throw domainError('invalid_recipe', '配方操作或作用范围不完整', [...new Set(invalid)])
  const needed = new Set(Object.keys(recipe.operations).filter((field) => !recipe.operations[field].dependency).flatMap(dependenciesFor))
  const orphaned = Object.keys(recipe.operations).filter((field) => recipe.operations[field].dependency && !needed.has(field))
  if (orphaned.length) throw domainError('invalid_dependency', '依赖项不属于此风格的作用范围', orphaned)
  const source = recipe.source ?? {}
  if (typeof source !== 'object' || Array.isArray(source) || recipe.source === null) throw domainError('invalid_source', '配方来源必须是对象')
  const meaningful = Object.values(recipe.operations).some((operation) => !operation.dependency
    && (operation.mode === 'set' || (Array.isArray(operation.value) ? operation.value.some((value) => value !== 0) : operation.value !== 0)))
  if (!allowEmpty && !meaningful) throw domainError('empty_recipe', '没有可保存的风格贡献')
  return recipe
}

export function applyStyleRecipe(recipe, params, { lockedFields = [], ignoreInput = false } = {}) {
  validateRecipe(recipe)
  validateParams(params)
  const unknownLocks = Array.isArray(lockedFields) ? lockedFields.filter((field) => !PARAM_FIELDS.includes(field)) : []
  if (!Array.isArray(lockedFields) || unknownLocks.length) throw domainError('invalid_locks', '保护项不属于现有参数', unknownLocks)
  if (!ignoreInput && !equalValue(recipe.input_contract, inputContract(params))) throw domainError('input_mismatch', '风格与当前输入基准或显示映射不匹配')
  const candidate = clone(params)
  for (const [field, operation] of Object.entries(recipe.operations)) {
    candidate[field] = operation.mode === 'set' ? clone(operation.value) : addValues(candidate[field], operation.value)
    if (field === 'hue') candidate[field] = wrapHue(candidate[field])
  }
  const conflicts = lockedFields.filter((field) => !equalValue(params[field], candidate[field]))
  if (conflicts.length) throw domainError('locked_fields', '风格与受保护参数冲突', conflicts)
  validateParams(candidate)
  return candidate
}

export function recipeCanSave(workspace) {
  const reasons = []
  if (workspace.input_status === 'pending_confirmation') reasons.push('输入条件已改变，需在兼容样张上重新确认风格')
  if (workspace.baseline?.classification === 'unclassified' && workspace.baseline.unknown_fields?.length) reasons.push('旧参数来源未知，需明确选择保留或排除的内容')
  if (!Object.values(workspace.recipe_projection?.operations || {}).some((operation) => !operation.dependency)) reasons.push('没有可保存的风格贡献')
  return { allowed: !reasons.length, reasons }
}

export function buildStyleRecipe(workspace, { operations } = {}) {
  const eligibility = recipeCanSave(workspace)
  if (!eligibility.allowed) throw domainError('recipe_not_ready', eligibility.reasons.join('；'))
  const projection = workspace.recipe_projection
  const recipe = { format_version: 1, kind: 'portable_style', input_contract: clone(projection.input_contract),
    operations: clone(operations || projection.operations), source: { workspace_id: workspace.id,
      transaction_ids: [...new Set(projection.contributions.map((entry) => entry.id).filter(Boolean))],
      contributions: clone(projection.contributions), corrections_after_style: Boolean(projection.corrections_after_style) } }
  validateRecipe(recipe)
  return recipe
}

export function neutralParamsFor(contract) {
  validateInputContract(contract)
  return normalizeParams({ ...defaultParams(), base_photo_style: contract.base_photo_style, tone_map: contract.tone_map })
}
