const BASE = '/api/photos'

async function photoFetch(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST', credentials: 'include', body,
  })
  if (response.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw Object.assign(new Error('登录已过期，请重新登录'), { status: 401 })
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw Object.assign(new Error(
      typeof data.detail === 'string' ? data.detail : `照片处理失败：${response.status}`,
    ), { status: response.status })
  }
  return response
}

export function normalizedPhotoMetadata(metadata, inputStyle, sourceDigest) {
  const management = metadata?.color_management
  if (
    management?.version !== 1 || management.input_style !== inputStyle ||
    metadata.source_digest !== sourceDigest ||
    !Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) ||
    metadata.width < 1 || metadata.height < 1 || Math.max(metadata.width, metadata.height) > 2048 ||
    !Number.isInteger(metadata.source_width) || !Number.isInteger(metadata.source_height) ||
    metadata.source_width < 1 || metadata.source_height < 1 ||
    metadata.source_width * metadata.source_height > 64_000_000
  ) throw new Error('照片规范化结果与当前来源不一致，请重新上传')
  return metadata
}

export async function normalizePhoto(file, inputStyle, sourceDigest) {
  const body = new FormData()
  body.append('file', file, file.name)
  body.append('input_style', inputStyle)
  const response = await photoFetch('/normalize', body)
  let metadata
  try {
    metadata = JSON.parse(response.headers.get('X-Photo-Metadata'))
  } catch {
    throw new Error('照片规范化结果缺少色彩信息，请重新上传')
  }
  normalizedPhotoMetadata(metadata, inputStyle, sourceDigest)
  return { blob: await response.blob(), metadata }
}

export async function exportPhoto({ file, params, sourceDigest, format = 'jpeg', quality = 95 }) {
  if (!file) throw new Error('导出原分辨率照片需要重新绑定原文件')
  if (!sourceDigest) throw new Error('照片缺少来源信息，请重新绑定')
  const body = new FormData()
  body.append('file', file, file.name)
  body.append('params', JSON.stringify(params))
  body.append('source_digest', sourceDigest)
  body.append('format', format)
  body.append('quality', String(quality))
  const response = await photoFetch('/export', body)
  const disposition = response.headers.get('Content-Disposition') || ''
  const filename = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  let name = `photo_adjusted_sRGB.${format === 'png' ? 'png' : 'jpg'}`
  if (filename) {
    try { name = decodeURIComponent(filename[1]) } catch { /* Use the safe default filename. */ }
  }
  return { blob: await response.blob(), name }
}

export function savePhotoFile(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  // eslint-disable-next-line no-control-regex
  link.download = String(name).replace(/[\u0000-\u001f\u007f/\\]/g, '_')
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
