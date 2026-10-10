import { defaultParams, generateLUT, normalizeParams } from './lutEngine.js'
import { domainError, inputContract, validateParams } from './styleRecipe.js'

export const DIAGNOSTIC_BINS = 64
export const DIAGNOSTIC_MAX_SIDE = 256
export const CLIP_HIGH = 0.98
export const CLIP_LOW = 0.02
export const DIAGNOSTIC_VERSION = 'preview-diagnostics-1'
const LUMA = [0.2126, 0.7152, 0.0722]
const clamp01 = (value) => Math.max(0, Math.min(1, value))
const smoothstep = (value) => { const x = clamp01(value); return x * x * (3 - 2 * x) }

export function diagnosticDimensions(width, height, maxSide = DIAGNOSTIC_MAX_SIDE) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || !Number.isInteger(maxSide) || maxSide < 1 || maxSide > DIAGNOSTIC_MAX_SIDE) {
    throw domainError('invalid_image', '诊断需要有效的图片尺寸')
  }
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function technicalBaseline(params) {
  validateParams(params, { complete: false })
  const current = normalizeParams(params)
  validateParams(current)
  return { ...defaultParams(), base_photo_style: current.base_photo_style, tone_map: current.tone_map }
}

function assertImage({ data, width, height } = {}) {
  diagnosticDimensions(width, height)
  if (Math.max(width, height) > DIAGNOSTIC_MAX_SIDE
    || !(data instanceof Uint8ClampedArray || data instanceof Uint8Array)
    || data.length !== width * height * 4) {
    throw domainError('invalid_image', '诊断仅接收长边不超过 256 像素的 RGBA 预览')
  }
}

// Same R-fast trilinear sampling as applyLUTToImageData/WebGL. Keep float
// results until measurement; only the diagnostic display is quantized to bytes.
export function renderDiagnosticPixels(image, params) {
  assertImage(image)
  validateParams(params, { complete: false })
  const current = normalizeParams(params)
  validateParams(current)
  const { data: lut, size } = generateLUT(current, 33)
  const scale = size - 1
  const out = new Float32Array(image.width * image.height * 3)
  for (let pixel = 0; pixel < out.length / 3; pixel++) {
    const source = pixel * 4
    const x = image.data[source] / 255 * scale
    const y = image.data[source + 1] / 255 * scale
    const z = image.data[source + 2] / 255 * scale
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
    const x1 = Math.min(x0 + 1, scale), y1 = Math.min(y0 + 1, scale), z1 = Math.min(z0 + 1, scale)
    const dx = x - x0, dy = y - y0, dz = z - z0
    const at = (r, g, b, channel) => lut[(b * size * size + g * size + r) * 4 + channel]
    for (let channel = 0; channel < 3; channel++) {
      const c00 = at(x0, y0, z0, channel) * (1 - dx) + at(x1, y0, z0, channel) * dx
      const c10 = at(x0, y1, z0, channel) * (1 - dx) + at(x1, y1, z0, channel) * dx
      const c01 = at(x0, y0, z1, channel) * (1 - dx) + at(x1, y0, z1, channel) * dx
      const c11 = at(x0, y1, z1, channel) * (1 - dx) + at(x1, y1, z1, channel) * dx
      out[pixel * 3 + channel] = (c00 * (1 - dy) + c10 * dy) * (1 - dz) + (c01 * (1 - dy) + c11 * dy) * dz
    }
  }
  return out
}

export function summarizeDiagnosticPixels(pixels, sourceRgba) {
  if (!(pixels instanceof Float32Array) || pixels.length % 3 !== 0
    || !(sourceRgba instanceof Uint8ClampedArray || sourceRgba instanceof Uint8Array)
    || sourceRgba.length !== pixels.length / 3 * 4) throw domainError('invalid_image', '诊断像素格式不正确')
  const histograms = Object.fromEntries(['luma', 'r', 'g', 'b'].map((key) => [key, new Array(DIAGNOSTIC_BINS).fill(0)]))
  let count = 0, high = 0, low = 0
  const mask = new Uint8Array(pixels.length / 3)
  const bin = (value) => Math.min(DIAGNOSTIC_BINS - 1, Math.floor(clamp01(value) * DIAGNOSTIC_BINS))
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (sourceRgba[pixel * 4 + 3] === 0) continue
    const r = pixels[pixel * 3], g = pixels[pixel * 3 + 1], b = pixels[pixel * 3 + 2]
    if (![r, g, b].every(Number.isFinite)) throw domainError('invalid_image', '诊断像素包含无效数值')
    const maximum = Math.max(r, g, b)
    if (maximum > Math.fround(CLIP_HIGH)) { high++; mask[pixel] = 1 }
    else if (maximum < Math.fround(CLIP_LOW)) { low++; mask[pixel] = 2 }
    histograms.r[bin(r)]++; histograms.g[bin(g)]++; histograms.b[bin(b)]++
    histograms.luma[bin(r * LUMA[0] + g * LUMA[1] + b * LUMA[2])]++
    count++
  }
  if (!count) throw domainError('unmeasurable', '图片没有可测量的非透明像素')
  return { histograms, sampled_pixels: count, highlight_clip_pct: high / count * 100,
    shadow_clip_pct: low / count * 100, mask }
}

export function measureDiagnostics(image, params) {
  assertImage(image)
  const baselineParams = technicalBaseline(params)
  const normalized = normalizeParams(params)
  const baselinePixels = renderDiagnosticPixels(image, baselineParams)
  const currentPixels = renderDiagnosticPixels(image, normalized)
  const { mask: ignored, ...baseline } = summarizeDiagnosticPixels(baselinePixels, image.data)
  const { mask, ...current } = summarizeDiagnosticPixels(currentPixels, image.data)
  const currentBytes = new Uint8ClampedArray(image.data.length)
  const overlayBytes = new Uint8ClampedArray(image.data.length)
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * 4
    for (let channel = 0; channel < 3; channel++) currentBytes[offset + channel] = Math.round(currentPixels[pixel * 3 + channel] * 255)
    currentBytes[offset + 3] = image.data[offset + 3]
    if (mask[pixel]) overlayBytes.set(mask[pixel] === 1 ? [255, 190, 80, 160] : [95, 165, 255, 160], offset)
  }
  return { version: DIAGNOSTIC_VERSION, width: image.width, height: image.height,
    sampled_pixels: current.sampled_pixels, input_contract: inputContract(normalized),
    baseline_definition: '相同输入基准的中性参数；V-Log 保留当前显示映射',
    baseline, current, highlight_clip_delta_pct: current.highlight_clip_pct - baseline.highlight_clip_pct,
    shadow_clip_delta_pct: current.shadow_clip_pct - baseline.shadow_clip_pct,
    current_pixels: currentBytes, overlay_pixels: overlayBytes }
}

export function curvePoints(strength, count = 65) {
  if (!Number.isFinite(strength) || strength < -1 || strength > 1 || !Number.isInteger(count) || count < 2 || count > 361) {
    throw domainError('invalid_curve', 'S 曲线参数不正确')
  }
  return Array.from({ length: count }, (_, index) => {
    const x = index / (count - 1)
    return { x, y: x + strength * (smoothstep(x) - x) }
  })
}

export function hueWeight(hue, center, width) {
  if (![hue, center, width].every(Number.isFinite) || width < 1 || width > 180) throw domainError('invalid_hue_range', '局部色相范围不正确')
  const shifted = (hue - center + 180) % 360
  const distance = Math.abs((shifted < 0 ? shifted + 360 : shifted) - 180)
  return 1 - smoothstep(distance / width)
}
