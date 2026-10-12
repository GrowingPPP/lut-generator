export const SUBJECT_ANALYSIS_VERSION = 'subject-regions-1'
export const MAX_SUBJECT_REGIONS = 16
export const MIN_SUBJECT_CONFIDENCE = .8
export const SUBJECT_SELECTION_LABELS = Object.freeze({
  auto: '自动识别', portrait: '包含人物（人工修正）', non_portrait: '无人物（人工修正）',
})

const SUBJECT_MODES = new Set(['unknown', 'portrait', 'non_portrait'])
const STATUSES = new Set(['resolved', 'uncertain', 'failed', 'disabled'])
const REGION_KINDS = new Set(['face', 'hand', 'exposed_skin'])
const metadataOf = sample => sample?.metadata || sample || {}
const finiteUnit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

export function normalizeSubjectRegions(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_SUBJECT_REGIONS).flatMap(region => {
    const bounds = region?.bounds
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(finiteUnit)
      || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || !REGION_KINDS.has(region.kind)
      || !finiteUnit(region.confidence)) return []
    return [{ bounds: [...bounds], kind: region.kind, confidence: region.confidence }]
  })
}

export function normalizeSubjectDetection(value, sourceDigest, inputStyle) {
  if (!value || typeof value !== 'object' || value.version !== SUBJECT_ANALYSIS_VERSION
    || !STATUSES.has(value.status) || !SUBJECT_MODES.has(value.subject_mode)
    || !finiteUnit(value.confidence) || !['auto', 'manual'].includes(value.source)
    || value.mask_mode !== undefined && !['skin_candidates', 'all_pixels'].includes(value.mask_mode)
    || value.source === 'auto' && value.mask_mode === 'all_pixels'
    || (sourceDigest !== undefined && value.source_digest !== sourceDigest)
    || (inputStyle !== undefined && value.input_style !== inputStyle)
    || !Array.isArray(value.regions) || value.regions.length > MAX_SUBJECT_REGIONS) return null
  const regions = normalizeSubjectRegions(value.regions)
  if (regions.length !== value.regions.length
    || value.subject_mode !== 'portrait' && regions.length > 0
    || value.status !== 'resolved' && value.subject_mode !== 'unknown'
    || value.status === 'resolved' && (value.subject_mode === 'unknown' || value.confidence < MIN_SUBJECT_CONFIDENCE)) return null
  return {
    version: SUBJECT_ANALYSIS_VERSION, status: value.status, subject_mode: value.subject_mode,
    confidence: value.confidence, regions: regions.filter(region => region.confidence >= MIN_SUBJECT_CONFIDENCE), source: value.source,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 240) : '',
    mask_mode: value.mask_mode === 'all_pixels' && value.source === 'manual' ? 'all_pixels' : 'skin_candidates',
    ...(typeof value.source_digest === 'string' ? { source_digest: value.source_digest } : {}),
    ...(typeof value.input_style === 'string' ? { input_style: value.input_style } : {}),
  }
}

export function subjectSelection(sample) {
  const metadata = metadataOf(sample)
  if (Object.hasOwn(SUBJECT_SELECTION_LABELS, metadata.subject_selection)) return metadata.subject_selection
  // Existing explicit annotations retain the user's decision when automatic detection is introduced.
  return metadata.subject_mode === 'portrait' || metadata.subject_mode === 'non_portrait'
    ? metadata.subject_mode : 'auto'
}

export function effectiveSubjectProtection(sample) {
  const metadata = metadataOf(sample)
  const selection = subjectSelection(metadata)
  const inputStyle = metadata.input_contract?.base_photo_style || metadata.color_management?.input_style
  const detection = normalizeSubjectDetection(metadata.subject_detection, metadata.source_digest, inputStyle)
  const automaticMode = detection?.status === 'resolved' ? detection.subject_mode : 'unknown'
  const subject_mode = selection === 'auto' ? automaticMode : selection
  const manualRegions = Array.isArray(metadata.subject_regions)
  const regions = subject_mode === 'portrait'
    ? manualRegions ? normalizeSubjectRegions(metadata.subject_regions).filter(region => region.confidence >= MIN_SUBJECT_CONFIDENCE)
      : detection?.status === 'resolved' && detection.subject_mode === 'portrait' ? detection.regions : []
    : []
  const mask_mode = manualRegions && metadata.subject_region_mask_mode === 'all_pixels'
    ? 'all_pixels' : 'skin_candidates'
  return { selection, subject_mode, regions, mask_mode, detection,
    source: selection === 'auto' && !manualRegions ? 'auto' : 'manual', manual_regions: manualRegions,
    status: detection?.status || 'idle', enabled: subject_mode === 'portrait' && regions.length > 0 }
}

export function subjectStatusText(sample, detecting = false) {
  if (detecting) return '正在识别人像与肤色区域…'
  const result = effectiveSubjectProtection(sample)
  if (result.selection !== 'auto') return result.subject_mode === 'portrait' ? '人工确认：包含人物' : '人工确认：无人物'
  if (result.status === 'failed') return '自动识别未完成'
  if (result.status === 'disabled') return '自动识别暂不可用'
  if (result.status === 'uncertain' || result.subject_mode === 'unknown' && result.status === 'resolved') return '自动识别暂不确定'
  if (result.subject_mode === 'non_portrait') return '自动识别：无人物'
  if (result.subject_mode === 'portrait') return '自动识别：包含人物'
  return '将在调色前自动识别照片内容'
}

export function regionFromPoints(start, end) {
  if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2
    || ![...start, ...end].every(finiteUnit)) return null
  const bounds = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])]
  if (bounds[2] - bounds[0] < .005 || bounds[3] - bounds[1] < .005) return null
  return { bounds, kind: 'exposed_skin', confidence: 1 }
}

export function regionProtectionText(sample) {
  const result = effectiveSubjectProtection(sample)
  if (result.subject_mode === 'non_portrait') return '无需人物肤色保护'
  if (result.subject_mode === 'unknown') return '尚未启用肤色保护；可等待自动识别或人工修正'
  if (!result.enabled) return '尚无可用保护区域，请检查或框选露出的皮肤'
  return `${result.regions.length} 个区域参与肤色保护检查`
}
