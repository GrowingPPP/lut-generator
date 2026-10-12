import { PARAM_FIELDS } from './styleRecipe.js'
import { normalizeSubjectMode } from './samples.js'

export function parameterSignature(params) {
  return JSON.stringify(PARAM_FIELDS.map((field) => [field, params[field]]))
}

export function contextSignature(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || !['natural', 'preserve', 'style_only'].includes(context.goal_mode)
    || !Array.isArray(context.locked_fields)
    || context.locked_fields.some(field => !PARAM_FIELDS.includes(field))
    || (Object.hasOwn(context, 'subject_mode')
      && normalizeSubjectMode(context.subject_mode) !== context.subject_mode)) return null
  return JSON.stringify({
    goal_mode: context.goal_mode,
    locked_fields: [...new Set(context.locked_fields)].sort(),
    subject_mode: normalizeSubjectMode(context.subject_mode),
  })
}

export function reportIsHistorical(report, { params, primaryId, sourceDigest, context } = {}) {
  if (!report || !params || !report.params) return true
  const reportContext = Object.hasOwn(report, '_request_context')
    ? report._request_context : report.context
  const frozenContext = contextSignature(reportContext)
  if (!frozenContext || frozenContext !== contextSignature(context)) return true
  const sampleId = Object.hasOwn(report, '_sample_id') ? report._sample_id : report.main_sample_id
  const digest = Object.hasOwn(report, '_source_digest') ? report._source_digest : report.source_digest
  return parameterSignature(report.params) !== parameterSignature(params)
    || (sampleId ?? null) !== (primaryId ?? null)
    || (digest ?? null) !== (sourceDigest ?? null)
}

export function equivalentCandidate(a, b, tolerance = 1e-9) {
  const same = (left, right) => {
    if (typeof left === 'number' || typeof right === 'number')
      return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
      return left === right && left !== undefined
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]))
  }
  return !!a && !!b && PARAM_FIELDS.every(field => same(a[field], b[field]))
}

export function effectivePhases(result, { chatPurpose } = {}) {
  return (result.steps || [])
    .filter((stage) => stage.applied && stage.params_before && stage.params_after)
    .map((stage) => ({
      before_params: stage.params_before,
      after_params: stage.params_after,
      applied: true,
      purpose: chatPurpose || stage.purpose || (stage.stage === 'style' ? 'style' : 'correction'),
      source: stage.stage,
    }))
}

export function versionSource(workspace) {
  const { report, validation, samples, primary_sample_id, ...snapshot } = workspace
  return { workspace_snapshot: snapshot, workspace_id: workspace.id }
}
