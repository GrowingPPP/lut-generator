import { inputContract } from './styleRecipe.js'
import { normalizePhoto } from './photoApi.js'

export const SUBJECT_MODE_LABELS = Object.freeze({ unknown: '未确认', portrait: '包含人物', non_portrait: '无人物' })

export function normalizeSubjectMode(value) {
  return typeof value === 'string' && Object.hasOwn(SUBJECT_MODE_LABELS, value) ? value : 'unknown'
}

export function editingContextForSample(workspace, sample) {
  const metadata = sample?.metadata || sample
  return {
    goal_mode: workspace?.goal_mode || 'natural',
    locked_fields: [...(workspace?.locked_fields || [])],
    subject_mode: normalizeSubjectMode(metadata?.subject_mode),
  }
}

export async function contentDigest(value) {
  const bytes =
    value instanceof Blob
      ? await value.arrayBuffer()
      : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
}

export async function decodeSample(file, params, existing) {
  if (file.size > 32 * 1024 * 1024) throw new Error('单张图片需小于 32MB')
  const digest = await contentDigest(file)
  if (existing && digest !== existing.source_digest)
    throw new Error('照片内容与原样张不同，请添加为新的样张')
  const inputStyle = existing?.input_contract?.base_photo_style || params.base_photo_style || 'STD'
  const normalized = await normalizePhoto(file, inputStyle, digest)
  const photoMetadata = normalized.metadata
  const blob = normalized.blob
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (img.naturalWidth * img.naturalHeight > 64_000_000)
      throw new Error('图片超过 6400 万像素，请先缩小')
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    if (canvas.width !== photoMetadata.width || canvas.height !== photoMetadata.height)
      throw new Error('照片规范化尺寸不一致，请重新上传')
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    return {
      metadata: {
        ...existing,
        subject_mode: normalizeSubjectMode(existing?.subject_mode),
        id: existing?.id || crypto.randomUUID(),
        name: file.name,
        source_digest: digest,
        input_contract: existing?.input_contract || inputContract(params),
        origin: 'source',
        needs_rebind: false,
        preview_digest: await contentDigest(blob),
        width: canvas.width,
        height: canvas.height,
        source_width: photoMetadata.source_width,
        source_height: photoMetadata.source_height,
        color_management: photoMetadata.color_management,
        photo_metadata: photoMetadata,
      },
      file,
      canvas,
      blob,
      thumbnail: canvas.toDataURL('image/jpeg', 0.65),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function restoreSample(blob, metadata) {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d').drawImage(img, 0, 0)
    return {
      metadata: { ...metadata, subject_mode: normalizeSubjectMode(metadata?.subject_mode),
        origin: 'restored_preview', needs_rebind: true },
      file: null,
      canvas,
      blob,
      thumbnail: canvas.toDataURL('image/jpeg', 0.65),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function sampleMatches(sample, params) {
  const contract = sample?.input_contract
  if (!contract) return false
  const current = inputContract(params)
  if (!sampleIsNormalized(sample)) return false
  return (
    contract.base_photo_style === current.base_photo_style &&
    contract.output_encoding === current.output_encoding
  )
}

export function sampleIsNormalized(sample) {
  const management = sample?.color_management || sample?.photo_metadata?.color_management
  return management?.version === 1 &&
    management.input_style === sample?.input_contract?.base_photo_style
}
