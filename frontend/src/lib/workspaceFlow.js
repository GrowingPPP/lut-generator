import { PARAM_FIELDS } from './styleRecipe.js'

export function parameterSignature(params) {
  return JSON.stringify(PARAM_FIELDS.map((field) => [field, params[field]]))
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
