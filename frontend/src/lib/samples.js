import { inputContract } from './styleRecipe.js'

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
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (img.naturalWidth * img.naturalHeight > 64_000_000)
      throw new Error('图片超过 6400 万像素，请先缩小')
    const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.94))
    if (!blob) throw new Error('无法生成预览')
    return {
      metadata: {
        ...existing,
        id: existing?.id || crypto.randomUUID(),
        name: file.name,
        source_digest: digest,
        input_contract: existing?.input_contract || inputContract(params),
        origin: 'source',
        needs_rebind: false,
        preview_digest: await contentDigest(blob),
        width: canvas.width,
        height: canvas.height,
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
      metadata: { ...metadata, origin: 'restored_preview', needs_rebind: true },
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
  return (
    contract.base_photo_style === current.base_photo_style &&
    contract.output_encoding === current.output_encoding
  )
}
