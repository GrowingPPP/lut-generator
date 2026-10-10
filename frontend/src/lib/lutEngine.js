import { identityCurves, validateCurvePoints, prepareFreeCurves } from './curveMath.js'
import { validateExternalId, validateExternalOptions, sampleImportedLut } from './cubeLut.js'
import { resolveExternalLut } from './importedLuts.js'

// 参数化 3D LUT 生成,与后端 lut_engine 同数学(线性/编码分离管线)。
const LUMA = [0.2126, 0.7152, 0.0722]
const TINT_GAIN = 0.0002

export function defaultParams() {
  return {
    base_photo_style: 'STD',
    temp: 0,
    tint: 0,
    exposure: 0,
    contrast: 0,
    contrast_pivot: 0.462,
    saturation: 0,
    hue: 0,
    vibrance: 0,
    tone_map: 1,
    look_strength: 1,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    curve: 0,
    curve_points: identityCurves(),
    external_lut_id: null,
    external_lut_strength: 0,
    external_lut_mode: 'display',
    split_shadow_hue: 0,
    split_shadow_sat: 0,
    split_highlight_hue: 0,
    split_highlight_sat: 0,
    split_balance: 0.5,
    split_mid_hue: 0,
    split_mid_sat: 0,
    selective_hue_center: 30,
    selective_hue_width: 45,
    selective_hue_shift: 0,
    selective_saturation: 0,
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
  }
}

// 历史会话和未重启的旧版 API 可能缺少新参数；预览、控件和导出共用同一套补全规则。
export function normalizeParams(params) {
  const normalized = defaultParams()
  if (!params || typeof params !== 'object') return normalized
  for (const [key, fallback] of Object.entries(normalized)) {
    const value = params[key]
    if (key === 'curve_points' && value !== undefined) {
      normalized[key] = validateCurvePoints(value)
    } else if (key === 'external_lut_id' && value !== undefined) {
      normalized[key] = validateExternalId(value)
    } else if (Array.isArray(fallback)) {
      normalized[key] = fallback.map((item, i) => Number.isFinite(value?.[i]) ? value[i] : item)
    } else if (typeof fallback === 'number' && Number.isFinite(value)) {
      normalized[key] = value
    } else if (typeof fallback === 'string' && typeof value === 'string') {
      normalized[key] = value
    }
  }
  validateExternalOptions(normalized.external_lut_id, normalized.external_lut_strength,
    normalized.external_lut_mode, normalized.base_photo_style)
  return normalized
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// 保持亮度/色相,等比降饱和让 RGB 回 [0,1]
function gamutClamp(r, g, b) {
  const luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  const mn = Math.min(r, g, b)
  const mx = Math.max(r, g, b)
  let scale = 1
  if (mn < 0) scale = Math.min(scale, luma / Math.max(luma - mn, 1e-6))
  if (mx > 1) scale = Math.min(scale, (1 - luma) / Math.max(mx - luma, 1e-6))
  scale = Math.max(0, Math.min(1, scale))
  return [luma + (r - luma) * scale, luma + (g - luma) * scale, luma + (b - luma) * scale]
}

// ---- 色彩空间 ----

function srgbEotf(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function srgbOetf(lin) {
  lin = Math.max(0, lin)
  return lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055
}

function rec709Oetf(lin) {
  lin = Math.max(0, lin)
  return lin <= 0.018 ? 4.5 * lin : 1.099 * Math.pow(lin, 0.45) - 0.099
}

function rec709Eotf(c) {
  return c <= 0.081 ? c / 4.5 : Math.pow((c + 0.099) / 1.099, 1 / 0.45)
}

function kelvinToRgb(kelvin) {
  const temp = kelvin / 100
  let r, g, b
  if (temp <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(temp) - 161.1195681661
    b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307
  } else if (temp <= 88) {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592)
    g = 288.1221695283 * Math.log(temp) - 234.7305138614
    b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592)
    g = 288.1221695283 * Math.log(temp) - 234.7305138614
    b = 255
  }
  const c = (v) => Math.max(0, Math.min(1, v / 255))
  return [c(r), c(g), c(b)]
}

function whiteBalanceGain(tempOffset, tint) {
  const kelvin = 6500 - tempOffset
  const rgb = kelvinToRgb(kelvin)
  const neutral = kelvinToRgb(6500)
  const gain = [rgb[0] / neutral[0], rgb[1] / neutral[1], rgb[2] / neutral[2]]
  gain[1] *= 1 + tint * TINT_GAIN
  return gain
}

// ---- V-Log → 线性 Rec.709 ----

const V_GAMUT_TO_709 = [
  [1.806576, -0.695697, -0.110879],
  [-0.17009, 1.305955, -0.135865],
  [-0.025206, -0.154468, 1.179674],
]

function vlogToLinear(l) {
  return l < 0.181 ? (l - 0.125) / 5.6 : Math.pow(10, (l - 0.598206) / 0.241514) - 0.00873
}

function toneMapAces(x, strength = 1) {
  const a = 2.51
  const b = 0.03
  const c = 2.43
  const d = 0.59
  const e = 0.14
  x = Math.max(0, x)
  const mapped = (x * (a * x + b)) / (x * (c * x + d) + e)
  return x + (mapped - x) * strength
}

function vlogDecodeToRec709Linear(r, g, b) {
  const lr = vlogToLinear(r)
  const lg = vlogToLinear(g)
  const lb = vlogToLinear(b)
  const nr = V_GAMUT_TO_709[0][0] * lr + V_GAMUT_TO_709[0][1] * lg + V_GAMUT_TO_709[0][2] * lb
  const ng = V_GAMUT_TO_709[1][0] * lr + V_GAMUT_TO_709[1][1] * lg + V_GAMUT_TO_709[1][2] * lb
  const nb = V_GAMUT_TO_709[2][0] * lr + V_GAMUT_TO_709[2][1] * lg + V_GAMUT_TO_709[2][2] * lb
  return [nr, ng, nb]
}

// ---- 算子 ----

function applyTechnicalOps(r, g, b, p) {
  const wb = whiteBalanceGain(p.temp, p.tint)
  r *= wb[0]
  g *= wb[1]
  b *= wb[2]
  const exp = Math.pow(2, p.exposure)
  r *= exp
  g *= exp
  b *= exp
  return [r, g, b]
}

function applyCreativeLinearOps(r, g, b, p) {
  return [(r + p.lift[0]) * p.gain[0],
          (g + p.lift[1]) * p.gain[1],
          (b + p.lift[2]) * p.gain[2]]
}

// ---- 影调分区与分离色调(逐点,与后端 transforms.py 同数学)----
// 掩码必须平滑:33³ 网格 + 三线性插值在硬阈值拐点处会产生明显串色。
const HIGHLIGHT_KNEE = 0.5
const SHADOW_KNEE = 0.5

function smoothstep(x) {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

function rescaleToLuma(r, g, b, yOld, yNew) {
  const sc = yNew / Math.max(yOld, 1e-6)
  return [r * sc, g * sc, b * sc]
}

function applyHighlights(r, g, b, amount) {
  if (amount === 0) return [r, g, b]
  const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  const w = smoothstep((y - HIGHLIGHT_KNEE) / (1 - HIGHLIGHT_KNEE))
  return rescaleToLuma(r, g, b, y, y + amount * w * (1 - y))
}

function applyShadows(r, g, b, amount) {
  if (amount === 0) return [r, g, b]
  const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  const w = smoothstep((SHADOW_KNEE - y) / SHADOW_KNEE)
  return rescaleToLuma(r, g, b, y, y + amount * w * y)
}

// 白部层次:端点受控的单调映射。
function applyWhites(r, g, b, amount) {
  if (amount === 0) return [r, g, b]
  const c = (v) => Math.max(0, Math.min(1, v))
  const f = amount > 0
    ? (v) => v + amount * c(v) * c(v) * (1 - c(v))
    : (v) => {
        const x = c(v)
        return v + (amount / (1 - amount)) * (2 * x - x * x)
      }
  return [f(r), f(g), f(b)]
}

// 黑部层次:正值抬黑位,负值压暗部,全范围保持灰阶单调。
function applyBlacks(r, g, b, amount) {
  if (amount === 0) return [r, g, b]
  const c = (v) => Math.max(0, Math.min(1, v))
  const f = amount > 0
    ? (v) => v + (amount / (1 + amount)) * (1 - c(v)) * (1 - c(v))
    : (v) => v + amount * c(v) * (1 - c(v)) * (1 - c(v))
  return [f(r), f(g), f(b)]
}

// S 曲线:smoothstep(x) - x —— 暗部压低、亮部抬高,0/0.5/1 三点固定。
function applyCurve(r, g, b, strength) {
  if (strength === 0) return [r, g, b]
  const f = (v) => {
    const x = Math.max(0, Math.min(1, v))
    return v + strength * (smoothstep(x) - x)
  }
  return [f(r), f(g), f(b)]
}

function hueToRgb(hueDeg) {
  const h = ((hueDeg % 360) + 360) % 360 / 60
  const i = Math.floor(h) % 6
  const f = h - Math.floor(h)
  const table = [
    [1, f, 0], [1 - f, 1, 0], [0, 1, f],
    [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f],
  ]
  return table[i]
}

function applySplitTone(r, g, b, shHue, shSat, hiHue, hiSat, balance, midHue = 0, midSat = 0) {
  if (shSat === 0 && hiSat === 0 && midSat === 0) return [r, g, b]
  const y = Math.max(0, Math.min(1, LUMA[0] * r + LUMA[1] * g + LUMA[2] * b))
  const bl = Math.max(0, Math.min(1, balance))
  // balance 越大 → 高光染色覆盖越广(与 ACR 的 Balance 方向一致)
  const shW = bl < 1 ? smoothstep((1 - bl - y) / Math.max(1 - bl, 1e-6)) : 0
  const hiW = bl > 0 ? smoothstep((y - (1 - bl)) / Math.max(bl, 1e-6)) : 1
  let tr = 0, tg = 0, tb = 0
  if (shSat > 0) {
    const s = hueToRgb(shHue)
    tr += shW * (shSat * 0.5) * (s[0] - 0.5)
    tg += shW * (shSat * 0.5) * (s[1] - 0.5)
    tb += shW * (shSat * 0.5) * (s[2] - 0.5)
  }
  if (hiSat > 0) {
    const h = hueToRgb(hiHue)
    tr += hiW * (hiSat * 0.5) * (h[0] - 0.5)
    tg += hiW * (hiSat * 0.5) * (h[1] - 0.5)
    tb += hiW * (hiSat * 0.5) * (h[2] - 0.5)
  }
  if (midSat > 0) {
    const m = hueToRgb(midHue)
    const midW = smoothstep(y / 0.5) * smoothstep((1 - y) / 0.5)
    tr += midW * (midSat * 0.5) * (m[0] - 0.5)
    tg += midW * (midSat * 0.5) * (m[1] - 0.5)
    tb += midW * (midSat * 0.5) * (m[2] - 0.5)
  }
  return [r + tr, g + tg, b + tb]
}

function applyToneOps(r, g, b, p) {
  let o = applyHighlights(r, g, b, p.highlights)
  o = applyShadows(o[0], o[1], o[2], p.shadows)
  o = applyWhites(o[0], o[1], o[2], p.whites)
  o = applyBlacks(o[0], o[1], o[2], p.blacks)
  o = applyCurve(o[0], o[1], o[2], p.curve)
  o = applySplitTone(o[0], o[1], o[2], p.split_shadow_hue, p.split_shadow_sat,
                    p.split_highlight_hue, p.split_highlight_sat, p.split_balance,
                    p.split_mid_hue, p.split_mid_sat)
  return o
}

function applySelectiveColor(r, g, b, p) {
  if (p.selective_hue_shift === 0 && p.selective_saturation === 0) return [r, g, b]
  const cr = clamp01(r), cg = clamp01(g), cb = clamp01(b)
  const mx = Math.max(cr, cg, cb)
  const mn = Math.min(cr, cg, cb)
  const chroma = mx - mn
  const safe = Math.max(chroma, 1e-6)
  let hue
  if (mx === cr) hue = (((cg - cb) / safe) % 6 + 6) % 6
  else if (mx === cg) hue = (cb - cr) / safe + 2
  else hue = (cr - cg) / safe + 4
  hue *= 60
  const distance = Math.abs(((hue - p.selective_hue_center + 180 + 360) % 360) - 180)
  const weight = (1 - smoothstep(distance / p.selective_hue_width)) * smoothstep(chroma / 0.08)
  if (weight === 0) return [r, g, b]
  if (p.selective_hue_shift !== 0) {
    const rotated = rotateHue(r, g, b, p.selective_hue_shift)
    r += weight * (rotated[0] - r)
    g += weight * (rotated[1] - g)
    b += weight * (rotated[2] - b)
  }
  if (p.selective_saturation !== 0) {
    const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
    const scale = 1 + p.selective_saturation * weight
    r = y + (r - y) * scale
    g = y + (g - y) * scale
    b = y + (b - y) * scale
  }
  return [r, g, b]
}

function rotateHue(r, g, b, hue) {
  const theta = (hue * Math.PI) / 180
  const c = Math.cos(theta)
  const sn = Math.sin(theta)
  const m = [
    [0.213 + 0.787 * c - 0.213 * sn, 0.715 - 0.715 * c - 0.715 * sn, 0.072 - 0.072 * c + 0.928 * sn],
    [0.213 - 0.213 * c + 0.143 * sn, 0.715 + 0.285 * c + 0.140 * sn, 0.072 - 0.072 * c - 0.283 * sn],
    [0.213 - 0.213 * c - 0.787 * sn, 0.715 - 0.715 * c + 0.715 * sn, 0.072 + 0.928 * c + 0.072 * sn],
  ]
  return gamutClamp(
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  )
}

function applyEncodedOps(r, g, b, p) {
  if (p.contrast !== 0) {
    const k = 1 + (p.contrast < 0 ? p.contrast / (1 - 0.25 * p.contrast) : p.contrast)
    r = (r - p.contrast_pivot) * k + p.contrast_pivot
    g = (g - p.contrast_pivot) * k + p.contrast_pivot
    b = (b - p.contrast_pivot) * k + p.contrast_pivot
  }
  r = Math.pow(Math.max(0, r), 1 / p.gamma[0])
  g = Math.pow(Math.max(0, g), 1 / p.gamma[1])
  b = Math.pow(Math.max(0, b), 1 / p.gamma[2])
  const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  const s = 1 + p.saturation
  r = y + (r - y) * s
  g = y + (g - y) * s
  b = y + (b - y) * s
  if (p.hue !== 0) {
    const rotated = rotateHue(r, g, b, p.hue)
    r = rotated[0]
    g = rotated[1]
    b = rotated[2]
  }
  const selective = applySelectiveColor(r, g, b, p)
  r = selective[0]
  g = selective[1]
  b = selective[2]
  if (p.vibrance !== 0) {
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const sat = mx > 0 ? (mx - mn) / Math.max(mx, 1e-6) : 0
    const scale = 1 - sat
    const y2 = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
    const vs = 1 + p.vibrance * scale
    r = y2 + (r - y2) * vs
    g = y2 + (g - y2) * vs
    b = y2 + (b - y2) * vs
  }
  const t = applyToneOps(r, g, b, p)
  return [clamp01(t[0]), clamp01(t[1]), clamp01(t[2])]
}

// ---- 生成 ----

export function generateLUT(params = defaultParams(), size = 33) {
  params = normalizeParams(params)
  const n = size * size * size
  const data = new Float32Array(n * 4)
  const step = 1 / (size - 1)
  const isVlog = params.base_photo_style === 'VLOG'
  const encode = isVlog ? rec709Oetf : srgbOetf
  const external = resolveExternalLut(params.external_lut_id)
  const inputMode = params.external_lut_mode === 'input'
  const outputEncoding = isVlog ? 'Rec709' : 'sRGB'
  if (external && (inputMode
    ? external.input_encoding !== 'VLOG' || external.output_encoding !== 'Rec709'
    : external.input_encoding !== outputEncoding || external.output_encoding !== outputEncoding)) {
    throw new Error('外部 LUT 的输入与输出信号不匹配当前工作区')
  }
  const freeCurves = prepareFreeCurves(params.curve_points)
  let idx = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let rr = r * step
        let gg = g * step
        let bb = b * step
        if (inputMode) {
          const mapped = sampleImportedLut(external, rr, gg, bb)
          rr = rec709Eotf(mapped[0]); gg = rec709Eotf(mapped[1]); bb = rec709Eotf(mapped[2])
        } else if (isVlog) {
          const conv = vlogDecodeToRec709Linear(rr, gg, bb)
          rr = conv[0]
          gg = conv[1]
          bb = conv[2]
        } else {
          rr = srgbEotf(rr)
          gg = srgbEotf(gg)
          bb = srgbEotf(bb)
        }
        const lin = applyTechnicalOps(rr, gg, bb, params)
        rr = lin[0]
        gg = lin[1]
        bb = lin[2]
        if (isVlog && !inputMode) {
          rr = toneMapAces(rr, params.tone_map)
          gg = toneMapAces(gg, params.tone_map)
          bb = toneMapAces(bb, params.tone_map)
        }
        const creative = applyCreativeLinearOps(rr, gg, bb, params)
        const base = [clamp01(encode(rr)), clamp01(encode(gg)), clamp01(encode(bb))]
        const encoded = applyEncodedOps(encode(creative[0]), encode(creative[1]), encode(creative[2]), params)
        const enc = freeCurves(...encoded)
        let out = base.map((value, channel) => clamp01(value + params.look_strength * (enc[channel] - value)))
        if (external && !inputMode && params.external_lut_strength > 0) {
          const mapped = sampleImportedLut(external, ...out)
          out = out.map((value, channel) => clamp01(value + params.external_lut_strength * (mapped[channel] - value)))
        }
        data[idx++] = out[0]
        data[idx++] = out[1]
        data[idx++] = out[2]
        data[idx++] = 1
      }
    }
  }
  return { data, size }
}

// 与后端 lut_engine/cube.py 同格式:.cube 数据顺序 R 最快,其次 G,最慢 B。
const PHOTO_STYLE_TAGS = { STD: 'STD', NAT: 'NAT', VIVD: 'VIVD', VLOG: 'VLOG' }

function fmt(v) {
  // 对齐后端 f"{v:.6f}";补 -0.000000 → 0.000000
  const s = v.toFixed(6)
  return s === '-0.000000' ? '0.000000' : s
}

// 3D LUT → .cube 文本。photoStyle 非空时注入松下机内头 #LUMIXPHOTOSTYLE。
export function lutToCube(data, size, { title, photoStyle } = {}) {
  const lines = []
  if (title) lines.push(`TITLE "${String(title).replace(/["\r\n\x00-\x1f]/g, ' ').trim()}"`)
  if (photoStyle && PHOTO_STYLE_TAGS[photoStyle]) lines.push(`#LUMIXPHOTOSTYLE ${PHOTO_STYLE_TAGS[photoStyle]}`)
  lines.push(`LUT_3D_SIZE ${size}`)
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const o = (b * size * size + g * size + r) * 4
        lines.push(`${fmt(data[o])} ${fmt(data[o + 1])} ${fmt(data[o + 2])}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

// 参数 → .cube 文本(前端本地生成,用于未保存时直接下载)
export function paramsToCube(params, { title, mode = 'camera', size = 33 } = {}) {
  params = normalizeParams(params)
  const { data } = generateLUT(params, size)
  const photoStyle = mode === 'camera' ? params.base_photo_style : undefined
  const inputSignal = params.base_photo_style === 'VLOG' ? 'VLOG/V-Gamut' : `${params.base_photo_style}/sRGB`
  const outputSignal = params.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB'
  const labeledTitle = mode === 'camera' || !title ? title : `${title} [${inputSignal} -> ${outputSignal}]`
  return lutToCube(data, size, { title: labeledTitle, photoStyle })
}

// 把 LUT 应用到 ImageData,返回新的 ImageData(三线性采样)
export function applyLUTToImageData(imageData, lutData, size) {
  const src = imageData.data
  const out = new Uint8ClampedArray(src.length)
  const scale = size - 1
  const at = (x, y, z, c) => lutData[(z * size * size + y * size + x) * 4 + c]
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i] / 255
    const g = src[i + 1] / 255
    const b = src[i + 2] / 255
    const x = r * scale
    const y = g * scale
    const z = b * scale
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const z0 = Math.floor(z)
    const x1 = Math.min(x0 + 1, scale)
    const y1 = Math.min(y0 + 1, scale)
    const z1 = Math.min(z0 + 1, scale)
    const dx = x - x0
    const dy = y - y0
    const dz = z - z0
    for (let c = 0; c < 3; c++) {
      const c00 = at(x0, y0, z0, c) * (1 - dx) + at(x1, y0, z0, c) * dx
      const c10 = at(x0, y1, z0, c) * (1 - dx) + at(x1, y1, z0, c) * dx
      const c01 = at(x0, y0, z1, c) * (1 - dx) + at(x1, y0, z1, c) * dx
      const c11 = at(x0, y1, z1, c) * (1 - dx) + at(x1, y1, z1, c) * dx
      const c0 = c00 * (1 - dy) + c10 * dy
      const c1 = c01 * (1 - dy) + c11 * dy
      out[i + c] = Math.round((c0 * (1 - dz) + c1 * dz) * 255)
    }
    out[i + 3] = src[i + 3]
  }
  return new ImageData(out, imageData.width, imageData.height)
}
