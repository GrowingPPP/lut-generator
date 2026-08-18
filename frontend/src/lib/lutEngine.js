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
    saturation: 0,
    hue: 0,
    vibrance: 0,
    tone_map: 1,
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
  }
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

function vlogToLinearRgb(r, g, b, toneMap = 1) {
  const lr = vlogToLinear(r)
  const lg = vlogToLinear(g)
  const lb = vlogToLinear(b)
  const nr = V_GAMUT_TO_709[0][0] * lr + V_GAMUT_TO_709[0][1] * lg + V_GAMUT_TO_709[0][2] * lb
  const ng = V_GAMUT_TO_709[1][0] * lr + V_GAMUT_TO_709[1][1] * lg + V_GAMUT_TO_709[1][2] * lb
  const nb = V_GAMUT_TO_709[2][0] * lr + V_GAMUT_TO_709[2][1] * lg + V_GAMUT_TO_709[2][2] * lb
  return [toneMapAces(nr, toneMap), toneMapAces(ng, toneMap), toneMapAces(nb, toneMap)]
}

// ---- 算子 ----

function applyLinearOps(r, g, b, p) {
  const wb = whiteBalanceGain(p.temp, p.tint)
  r *= wb[0]
  g *= wb[1]
  b *= wb[2]
  const exp = Math.pow(2, p.exposure)
  r *= exp
  g *= exp
  b *= exp
  r += p.lift[0]
  g += p.lift[1]
  b += p.lift[2]
  r *= p.gain[0]
  g *= p.gain[1]
  b *= p.gain[2]
  return [r, g, b]
}

function applyEncodedOps(r, g, b, p) {
  const k = 1 + p.contrast
  r = (r - 0.462) * k + 0.462
  g = (g - 0.462) * k + 0.462
  b = (b - 0.462) * k + 0.462
  r = Math.pow(Math.max(0, r), 1 / p.gamma[0])
  g = Math.pow(Math.max(0, g), 1 / p.gamma[1])
  b = Math.pow(Math.max(0, b), 1 / p.gamma[2])
  const y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
  const s = 1 + p.saturation
  r = y + (r - y) * s
  g = y + (g - y) * s
  b = y + (b - y) * s
  if (p.hue !== 0) {
    const theta = (p.hue * Math.PI) / 180
    const c = Math.cos(theta)
    const sn = Math.sin(theta)
    const m = [
      [0.213 + 0.787 * c - 0.213 * sn, 0.715 - 0.715 * c - 0.715 * sn, 0.072 - 0.072 * c + 0.928 * sn],
      [0.213 - 0.213 * c + 0.143 * sn, 0.715 + 0.285 * c + 0.140 * sn, 0.072 - 0.072 * c - 0.283 * sn],
      [0.213 - 0.213 * c - 0.787 * sn, 0.715 - 0.715 * c + 0.715 * sn, 0.072 + 0.928 * c + 0.072 * sn],
    ]
    const nr = m[0][0] * r + m[0][1] * g + m[0][2] * b
    const ng = m[1][0] * r + m[1][1] * g + m[1][2] * b
    const nb = m[2][0] * r + m[2][1] * g + m[2][2] * b
    const gc = gamutClamp(nr, ng, nb)
    r = gc[0]
    g = gc[1]
    b = gc[2]
  }
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
  return [clamp01(r), clamp01(g), clamp01(b)]
}

// ---- 生成 ----

export function generateLUT(params = defaultParams(), size = 33) {
  const n = size * size * size
  const data = new Float32Array(n * 4)
  const step = 1 / (size - 1)
  const isVlog = params.base_photo_style === 'VLOG'
  let idx = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let rr = r * step
        let gg = g * step
        let bb = b * step
        if (isVlog) {
          const conv = vlogToLinearRgb(rr, gg, bb, params.tone_map)
          rr = conv[0]
          gg = conv[1]
          bb = conv[2]
        } else {
          rr = srgbEotf(rr)
          gg = srgbEotf(gg)
          bb = srgbEotf(bb)
        }
        const lin = applyLinearOps(rr, gg, bb, params)
        rr = lin[0]
        gg = lin[1]
        bb = lin[2]
        if (isVlog) {
          rr = rec709Oetf(rr)
          gg = rec709Oetf(gg)
          bb = rec709Oetf(bb)
        } else {
          rr = srgbOetf(rr)
          gg = srgbOetf(gg)
          bb = srgbOetf(bb)
        }
        const enc = applyEncodedOps(rr, gg, bb, params)
        data[idx++] = enc[0]
        data[idx++] = enc[1]
        data[idx++] = enc[2]
        data[idx++] = 1
      }
    }
  }
  return { data, size }
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
