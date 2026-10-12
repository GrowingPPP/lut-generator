import { PARAM_FIELDS } from './styleRecipe.js'
import { normalizeSubjectMode } from './samples.js'
import { MAX_SUBJECT_REGIONS, SUBJECT_ANALYSIS_VERSION } from './subjectAnalysis.js'

export function parameterSignature(params) {
  return JSON.stringify(PARAM_FIELDS.map((field) => [field, params[field]]))
}

const CONTEXT_FIELDS = new Set(['goal_mode', 'locked_fields', 'subject_mode', 'subject_detection_mode',
  'subject_analysis', 'skin_regions', 'skin_mask_mode'])
const ANALYSIS_FIELDS = new Set(['version', 'status', 'subject_mode', 'confidence', 'regions', 'source',
  'reason', 'mask_mode', 'source_digest', 'input_style'])
const REGION_FIELDS = new Set(['bounds', 'kind', 'confidence'])
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unitNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const knownKeys = (value, fields) => Object.keys(value).every(key => fields.has(key))

function regionSignature(value) {
  if (!Array.isArray(value) || value.length > MAX_SUBJECT_REGIONS) return undefined
  const regions = []
  for (const region of value) {
    if (!plainObject(region) || !knownKeys(region, REGION_FIELDS)
      || !Array.isArray(region.bounds) || region.bounds.length !== 4 || !region.bounds.every(unitNumber)
      || region.bounds[0] >= region.bounds[2] || region.bounds[1] >= region.bounds[3]
      || !['face', 'hand', 'exposed_skin'].includes(region.kind) || !unitNumber(region.confidence)) return undefined
    regions.push({ bounds: [...region.bounds], kind: region.kind, confidence: region.confidence })
  }
  return regions
}

function analysisSignature(value) {
  if (!plainObject(value) || !knownKeys(value, ANALYSIS_FIELDS)
    || value.version !== SUBJECT_ANALYSIS_VERSION
    || !['resolved', 'uncertain', 'failed', 'disabled'].includes(value.status)
    || normalizeSubjectMode(value.subject_mode) !== value.subject_mode || !unitNumber(value.confidence)
    || !['auto', 'manual'].includes(value.source)
    || !['skin_candidates', 'all_pixels'].includes(value.mask_mode)
    || (value.source === 'auto' && value.mask_mode !== 'skin_candidates')
    || (value.reason != null && (typeof value.reason !== 'string' || value.reason.length > 256))
    || (value.source_digest != null && (typeof value.source_digest !== 'string' || value.source_digest.length > 128))
    || (value.input_style != null && !['STD', 'NAT', 'VIVD', 'VLOG'].includes(value.input_style))) return undefined
  const regions = regionSignature(value.regions)
  if (!regions || (value.subject_mode !== 'portrait' && regions.length)
    || (value.status !== 'resolved' && (value.subject_mode !== 'unknown' || regions.length))
    || (value.status === 'resolved' && value.subject_mode === 'unknown')) return undefined
  return { version: value.version, status: value.status, subject_mode: value.subject_mode,
    confidence: value.confidence, regions, source: value.source, mask_mode: value.mask_mode,
    source_digest: value.source_digest ?? null, input_style: value.input_style ?? null }
}

export function contextSignature(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || !knownKeys(context, CONTEXT_FIELDS)
    || !['natural', 'preserve', 'style_only'].includes(context.goal_mode)
    || !Array.isArray(context.locked_fields)
    || context.locked_fields.some(field => !PARAM_FIELDS.includes(field))
    || (Object.hasOwn(context, 'subject_mode')
      && normalizeSubjectMode(context.subject_mode) !== context.subject_mode)) return null
  const detectionMode = Object.hasOwn(context, 'subject_detection_mode') ? context.subject_detection_mode : 'manual'
  const maskMode = Object.hasOwn(context, 'skin_mask_mode') ? context.skin_mask_mode : 'skin_candidates'
  if (!['manual', 'auto'].includes(detectionMode) || !['skin_candidates', 'all_pixels'].includes(maskMode)) return null
  if ((Object.hasOwn(context, 'subject_analysis') && context.subject_analysis === undefined)
    || (Object.hasOwn(context, 'skin_regions') && context.skin_regions === undefined)) return null
  const analysis = context.subject_analysis == null ? null : analysisSignature(context.subject_analysis)
  const regions = context.skin_regions == null ? null : regionSignature(context.skin_regions)
  if (analysis === undefined || regions === undefined) return null
  return JSON.stringify({
    goal_mode: context.goal_mode,
    locked_fields: [...new Set(context.locked_fields)].sort(),
    subject_mode: normalizeSubjectMode(context.subject_mode),
    subject_detection_mode: detectionMode,
    subject_analysis: analysis,
    skin_regions: regions,
    skin_mask_mode: maskMode,
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
