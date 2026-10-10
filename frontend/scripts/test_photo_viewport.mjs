import test from 'node:test'
import assert from 'node:assert/strict'
import { clampPhotoPan, fitPhotoScale, photoFramePoint, photoTransform, photoViewerMode, zoomPhotoAt } from '../src/lib/photoViewport.js'

const image = { width: 4000, height: 3000 }
const frame = { width: 1000, height: 600 }
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('fit preserves whole portrait and landscape at actual pixel scale', () => {
  assert.equal(fitPhotoScale(image, frame), 0.2)
  assert.equal(fitPhotoScale({ width: 3000, height: 4000 }, frame), 0.15)
  assert.equal(fitPhotoScale({ width: 100, height: 100 }, frame), 4)
})

test('manual zoom is 25–400%, while a fit below 25% cannot jump upward on zoom-out', () => {
  const fit = { scale: 0.2, x: 0, y: 0, fit: true }
  assert.equal(zoomPhotoAt(fit, 0.1, { x: 500, y: 300 }, image, frame), fit)
  const minimum = { ...fit, scale: 0.25 }
  assert.equal(zoomPhotoAt(minimum, 0.1, { x: 500, y: 300 }, image, frame), minimum)
  assert.equal(zoomPhotoAt(fit, 0.24, { x: 500, y: 300 }, image, frame).scale, 0.25)
  assert.equal(zoomPhotoAt({ ...fit, scale: 1 }, 8, { x: 500, y: 300 }, image, frame).scale, 4)
})

test('pointer zoom holds the same image pixel under the pointer', () => {
  const previous = { scale: 0.5, x: 70, y: -30, fit: false }
  const anchor = { x: 670, y: 230 }
  const next = zoomPhotoAt(previous, 1.4, anchor, image, frame)
  close((anchor.x - frame.width / 2 - previous.x) / previous.scale,
    (anchor.x - frame.width / 2 - next.x) / next.scale)
  close((anchor.y - frame.height / 2 - previous.y) / previous.scale,
    (anchor.y - frame.height / 2 - next.y) / next.scale)
})

test('pan limits keep the image covering the frame, and center axes that fit', () => {
  assert.deepEqual(clampPhotoPan({ scale: 0.25, x: 500, y: -500, fit: false }, image, frame),
    { scale: 0.25, x: 0, y: -75, fit: false })
  assert.deepEqual(clampPhotoPan({ scale: 1, x: -9000, y: 9000, fit: false }, image, frame),
    { scale: 1, x: -1500, y: 1200, fit: false })
})

test('1:1 transformation uses one CSS pixel for one source pixel', () => {
  assert.equal(photoTransform({ scale: 1, x: 20, y: -40 }, image, frame), 'translate(-1480px, -1240px) scale(1)')
})

test('paired view uses the same image coordinate for pointers in either pane', () => {
  const rect = { left: 10, top: 50, width: 1001 }
  const a = photoFramePoint({ x: 260, y: 300 }, rect, true)
  const b = photoFramePoint({ x: 761, y: 300 }, rect, true)
  assert.deepEqual(a, b)
  assert.deepEqual(a, { x: 250, y: 250 })
  const common = { scale: 0.6, x: 0, y: 0, fit: false }
  const pane = { width: 500, height: 600 }
  assert.deepEqual(zoomPhotoAt(common, 1, a, image, pane), zoomPhotoAt(common, 1, b, image, pane))
})

test('embedded split mode maps to paired view; narrow view defaults to slider', () => {
  assert.equal(photoViewerMode('split'), 'side-by-side')
  assert.equal(photoViewerMode('split', true), 'slider')
  assert.equal(photoViewerMode('side-by-side', true), 'slider')
  assert.equal(photoViewerMode('effect', true), 'effect')
  assert.equal(photoViewerMode('invalid'), 'slider')
})
