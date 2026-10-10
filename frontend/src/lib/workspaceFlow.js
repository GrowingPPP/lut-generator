import { PARAM_FIELDS } from './styleRecipe.js'

export function parameterSignature(params) {
  return JSON.stringify(PARAM_FIELDS.map((field) => [field, params[field]]))
}

export function equivalentCandidate(a, b, tolerance = 1e-9) {
  return PARAM_FIELDS.every((field) => {
    if (field === 'base_photo_style') return a[field] === b[field]
    const left = Array.isArray(a[field]) ? a[field] : [a[field]]
    const right = Array.isArray(b[field]) ? b[field] : [b[field]]
    return (
      left.length === right.length &&
      left.every(
        (value, i) =>
          Number.isFinite(value) &&
          Number.isFinite(right[i]) &&
          Math.abs(value - right[i]) <= tolerance,
      )
    )
  })
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
