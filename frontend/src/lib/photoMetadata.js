const UNKNOWN = { camera_make: '', camera_model: '', color_space: 'unknown', embedded_icc: false }

function cleanText(value) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 64)
}

function readExif(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const inside = (offset, length) => offset >= start && length >= 0 && offset + length <= end
  if (!inside(start, 8)) return {}
  const order = view.getUint16(start)
  if (order !== 0x4949 && order !== 0x4d4d) return {}
  const little = order === 0x4949
  if (view.getUint16(start + 2, little) !== 42) return {}
  const result = {}
  const seen = new Set()
  function readIFD(relative, exif = false) {
    const offset = start + relative
    if (seen.has(offset) || !inside(offset, 2)) return
    seen.add(offset)
    const count = view.getUint16(offset, little)
    if (count > 256 || !inside(offset + 2, count * 12 + 4)) return
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12
      const tag = view.getUint16(entry, little)
      const type = view.getUint16(entry + 2, little)
      const length = view.getUint32(entry + 4, little)
      if (
        !exif &&
        (tag === 0x010f || tag === 0x0110) &&
        type === 2 &&
        length <= 128 &&
        length > 0
      ) {
        const valueAt = length <= 4 ? entry + 8 : start + view.getUint32(entry + 8, little)
        if (inside(valueAt, length)) {
          const value = cleanText(
            new TextDecoder('utf-8').decode(bytes.subarray(valueAt, valueAt + length)),
          )
          result[tag === 0x010f ? 'camera_make' : 'camera_model'] = value
        }
      }
      if (!exif && tag === 0x8769 && type === 4 && length === 1) {
        readIFD(view.getUint32(entry + 8, little), true)
      }
      if (exif && tag === 0xa001 && type === 3 && length === 1) {
        const value = view.getUint16(entry + 8, little)
        result.color_space = value === 1 ? 'sRGB' : value === 0xffff ? 'uncalibrated' : 'unknown'
      }
    }
  }
  readIFD(view.getUint32(start + 4, little))
  return result
}

export function parsePhotoMetadata(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  const result = { ...UNKNOWN }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return result
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const size = (bytes[offset] << 8) | bytes[offset + 1]
    if (size < 2 || offset + size > bytes.length) break
    const start = offset + 2,
      end = offset + size
    if (
      marker === 0xe1 &&
      end - start >= 6 &&
      bytes[start] === 0x45 &&
      bytes[start + 1] === 0x78 &&
      bytes[start + 2] === 0x69 &&
      bytes[start + 3] === 0x66 &&
      bytes[start + 4] === 0 &&
      bytes[start + 5] === 0
    ) {
      Object.assign(result, readExif(bytes, start + 6, end))
    }
    if (
      marker === 0xe2 &&
      end - start >= 12 &&
      new TextDecoder().decode(bytes.subarray(start, start + 12)) === 'ICC_PROFILE\u0000'
    ) {
      result.embedded_icc = true
    }
    offset = end
  }
  return result
}

export async function readPhotoMetadata(file) {
  return parsePhotoMetadata(await file.slice(0, 512 * 1024).arrayBuffer())
}

export function photoMetadataNotes(metadata) {
  const info = metadata || UNKNOWN
  const camera = [info.camera_make, info.camera_model].filter(Boolean).join(' ')
  if (info.color_management?.version === 1) {
    const management = info.color_management
    return {
      camera: camera || '未识别相机信息',
      color: management.input_style === 'VLOG'
        ? '已保留 V-Log / V-Gamut 编码'
        : management.status === 'converted_srgb'
          ? '已按 ICC 统一为 sRGB'
          : management.status === 'declared_srgb'
            ? '已统一为 sRGB'
            : '未带 ICC，按 sRGB 解释',
      warning: management.warning || '',
      input: '相机信息不能证明直出或识别 Photo Style，请按拍摄设置确认输入。',
    }
  }
  const color =
    info.color_space === 'sRGB'
      ? 'EXIF 标记 sRGB'
      : info.color_space === 'uncalibrated'
        ? 'EXIF 标记未校准色彩空间'
        : '未识别色彩空间'
  return {
    camera: camera || '未识别相机信息',
    color,
    warning:
      info.color_space === 'sRGB' && !info.embedded_icc
        ? ''
        : info.embedded_icc
          ? '含 ICC 配置；浏览器与分析端的色彩处理可能不同。建议使用 sRGB 直出样张核对。'
          : '请核对相机色彩空间；普通照片建议先转为 sRGB，V-Log 请保留原编码。',
    input: '相机信息不能证明直出或识别 Photo Style，请按拍摄设置确认输入。',
  }
}
