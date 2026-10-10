import assert from 'node:assert/strict'
import test from 'node:test'
import { applyLUTToImageData, defaultParams, generateLUT } from '../src/lib/lutEngine.js'
import {
  CLIP_HIGH, CLIP_LOW, DIAGNOSTIC_BINS, curvePoints, diagnosticDimensions,
  hueWeight, measureDiagnostics, renderDiagnosticPixels, summarizeDiagnosticPixels, technicalBaseline,
} from '../src/lib/diagnostics.js'

const rgba = (...colors) => new Uint8ClampedArray(colors.flatMap((color) => [...color.slice(0, 3), color[3] ?? 255]))
const image = (...colors) => ({ data: rgba(...colors), width: colors.length, height: 1 })
const expectCode = (code) => (error) => error.code === code
const mass = (bins) => bins.reduce((sum, count) => sum + count, 0)

test('sampling keeps aspect ratio, never upscales, and bounds worker and fallback dimensions', () => {
  assert.deepEqual(diagnosticDimensions(6000, 4000), { width: 256, height: 171 })
  assert.deepEqual(diagnosticDimensions(4000, 6000, 128), { width: 85, height: 128 })
  assert.deepEqual(diagnosticDimensions(3, 2), { width: 3, height: 2 })
  assert.deepEqual(diagnosticDimensions(1, 65536), { width: 1, height: 256 })
  for (const args of [[0, 1], [1, 0], [1.2, 3], [1, 1, 257], [1, 1, 0]]) {
    assert.throws(() => diagnosticDimensions(...args), expectCode('invalid_image'))
  }
})

test('clipping uses strict float32 encoded RGB boundaries, not average luma', () => {
  const pixels = new Float32Array([
    1, 0, 0,                             // Red clipping counts even with low luma.
    0.019, 0.019, 0.019,                 // Every channel below the low boundary.
    0, 0, 0.021,                         // One non-dark channel prevents shadow clipping.
    CLIP_HIGH, CLIP_HIGH, CLIP_HIGH,     // Equality must not count as clipping.
    CLIP_LOW, CLIP_LOW, CLIP_LOW,
    1, 1, 1,                            // Transparent: excluded from numerator/denominator.
  ])
  const source = rgba([0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0, 0])
  const result = summarizeDiagnosticPixels(pixels, source)
  assert.equal(result.sampled_pixels, 5)
  assert.equal(result.highlight_clip_pct, 20)
  assert.equal(result.shadow_clip_pct, 20)
  assert.deepEqual([...result.mask], [1, 2, 0, 0, 0, 0])
  for (const bins of Object.values(result.histograms)) {
    assert.equal(bins.length, DIAGNOSTIC_BINS)
    assert.equal(mass(bins), 5)
  }
  assert.equal(result.histograms.luma[Math.floor(0.2126 * DIAGNOSTIC_BINS)], 1)
})

test('all-transparent or malformed source pixels are not reported as measurements', () => {
  assert.throws(() => summarizeDiagnosticPixels(new Float32Array([1, 1, 1]), rgba([1, 1, 1, 0])), expectCode('unmeasurable'))
  assert.throws(() => summarizeDiagnosticPixels(new Float32Array([NaN, 0, 0]), rgba([0, 0, 0])), expectCode('invalid_image'))
  assert.throws(() => summarizeDiagnosticPixels(new Float32Array([0, 0]), rgba([0, 0, 0])), expectCode('invalid_image'))
  assert.throws(() => summarizeDiagnosticPixels([0, 0, 0], rgba([0, 0, 0])), expectCode('invalid_image'))
  assert.throws(() => measureDiagnostics(image([255, 255, 255, 0]), defaultParams()), expectCode('unmeasurable'))
})

test('technical baseline preserves input and display mapping while neutralizing the full adjustment set', () => {
  const params = Object.freeze({ ...defaultParams(), base_photo_style: 'VLOG', tone_map: 0.3,
    exposure: 1.5, temp: -700, curve: 0.4, selective_hue_shift: 15,
    lift: Object.freeze([0.01, 0, -0.01]), gain: Object.freeze([1.05, 1, 0.95]) })
  const before = JSON.stringify(params)
  const baseline = technicalBaseline(params)
  assert.deepEqual(baseline, { ...defaultParams(), base_photo_style: 'VLOG', tone_map: 0.3 })
  assert.equal(JSON.stringify(params), before)
  assert.notEqual(baseline.lift, params.lift)
  assert.throws(() => technicalBaseline({ ...params, exposure: Infinity }))
})

test('neutral measurements have zero deltas and preserve the real source and alpha', () => {
  const source = image([0, 0, 0], [255, 255, 255], [128, 128, 128, 128], [255, 0, 0])
  const before = [...source.data]
  const result = measureDiagnostics(source, defaultParams())
  assert.equal(result.sampled_pixels, 4)
  assert.equal(result.highlight_clip_delta_pct, 0)
  assert.equal(result.shadow_clip_delta_pct, 0)
  assert.deepEqual(result.current.histograms, result.baseline.histograms)
  assert.equal(result.current.highlight_clip_pct, 50)
  assert.equal(result.current.shadow_clip_pct, 25)
  assert.deepEqual(result.input_contract, { base_photo_style: 'STD', tone_map: 1, output_encoding: 'sRGB' })
  assert.deepEqual([...result.current_pixels], before)
  assert.deepEqual([...source.data], before)
  assert.deepEqual([...result.overlay_pixels.slice(0, 4)], [95, 165, 255, 160])
  assert.deepEqual([...result.overlay_pixels.slice(4, 8)], [255, 190, 80, 160])
  assert.deepEqual([...result.overlay_pixels.slice(8, 12)], [0, 0, 0, 0])
})

test('current edits can add clipping while baseline remains neutral with clear percentage-point deltas', () => {
  const source = image([0, 0, 0], [255, 255, 255], [128, 128, 128], [48, 80, 96])
  const result = measureDiagnostics(source, { ...defaultParams(), exposure: 3 })
  assert.equal(result.baseline.highlight_clip_pct, 25)
  assert.equal(result.current.highlight_clip_pct, 50)
  assert.equal(result.highlight_clip_delta_pct, 25)
  assert.equal(result.shadow_clip_delta_pct, 0)
  assert.deepEqual([...result.overlay_pixels.slice(8, 12)], [255, 190, 80, 160])
})

test('diagnostic rendering follows the existing 33-point preview engine for standard and V-Log inputs', () => {
  const originalImageData = globalThis.ImageData
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }) } }
  try {
    const source = image([0, 0, 0], [255, 255, 255], [19, 102, 228], [234, 175, 65], [77, 48, 89, 128])
    for (const params of [
      { ...defaultParams(), exposure: 0.4, contrast: 0.2, curve: -0.2, hue: 7, gain: [1.02, 1, 0.98] },
      { ...defaultParams(), base_photo_style: 'VLOG', tone_map: 0.5, temp: -250, shadows: 0.2, selective_saturation: 0.1 },
    ]) {
      const lut = generateLUT(params, 33)
      const expected = applyLUTToImageData(source, lut.data, lut.size).data
      const actual = renderDiagnosticPixels(source, params)
      for (let pixel = 0; pixel < source.width; pixel++) {
        for (let channel = 0; channel < 3; channel++) {
          assert.equal(Math.round(actual[pixel * 3 + channel] * 255), expected[pixel * 4 + channel])
        }
      }
    }
  } finally {
    if (originalImageData === undefined) delete globalThis.ImageData
    else globalThis.ImageData = originalImageData
  }
})

test('rendering rejects oversized, missing, truncated, and invalid input instead of inventing measurements', () => {
  for (const source of [undefined, { width: 257, height: 1, data: new Uint8Array(257 * 4) },
    { width: 1, height: 1, data: [0, 0, 0, 255] }, { width: 2, height: 1, data: new Uint8Array(4) }]) {
    assert.throws(() => renderDiagnosticPixels(source, defaultParams()), expectCode('invalid_image'))
  }
  assert.throws(() => renderDiagnosticPixels(image([0, 0, 0]), { ...defaultParams(), base_photo_style: 'UNKNOWN' }))
})

test('S-curve shape follows existing fixed endpoints and midpoint and remains monotonic', () => {
  for (const strength of [-1, -0.3, 0, 0.3, 1]) {
    const points = curvePoints(strength)
    assert.deepEqual(points[0], { x: 0, y: 0 })
    assert.deepEqual(points[32], { x: 0.5, y: 0.5 })
    assert.deepEqual(points.at(-1), { x: 1, y: 1 })
    assert.ok(points.every(({ y }, index) => y >= 0 && y <= 1 && (!index || y >= points[index - 1].y)))
  }
  assert.ok(curvePoints(1)[16].y < 0.25)
  assert.ok(curvePoints(1)[48].y > 0.75)
  assert.throws(() => curvePoints(1.01), expectCode('invalid_curve'))
  assert.throws(() => curvePoints(0, 1), expectCode('invalid_curve'))
})

test('local hue shape joins the 0/360 boundary and uses the existing soft half-width', () => {
  assert.equal(hueWeight(0, 0, 45), 1)
  assert.equal(hueWeight(360, 0, 45), 1)
  assert.equal(hueWeight(0, 360, 45), 1)
  assert.equal(hueWeight(45, 0, 45), 0)
  assert.equal(hueWeight(315, 0, 45), 0)
  assert.equal(hueWeight(180, 0, 180), 0)
  assert.equal(hueWeight(22.5, 0, 45), 0.5)
  assert.equal(hueWeight(-22.5, 0, 45), 0.5)
  assert.throws(() => hueWeight(0, 0, 0), expectCode('invalid_hue_range'))
})
