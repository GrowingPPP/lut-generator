function sameInputContract(left, right) {
  if (left == null || right == null) return left == null && right == null
  if (typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
}

export function sampleMediaMatches(media, sample) {
  const metadata = media?.metadata
  return Boolean(metadata
    && metadata.id === sample.id
    && typeof sample.source_digest === 'string' && sample.source_digest.length > 0
    && metadata.source_digest === sample.source_digest
    && sameInputContract(metadata.input_contract, sample.input_contract)
    && (metadata.preview_digest ?? null) === (sample.preview_digest ?? null))
}

export function mergeRestoredMedia(current, restored, samples) {
  const merged = new Map()
  for (const sample of samples) {
    const present = current.get(sample.id)
    const cached = restored.get(sample.id)
    if (sampleMediaMatches(present, sample)) merged.set(sample.id, present)
    else if (sampleMediaMatches(cached, sample)) merged.set(sample.id, cached)
  }
  return merged
}
