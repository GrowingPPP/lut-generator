import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePhotoMetadata, photoMetadataNotes } from '../src/lib/photoMetadata.js'

function fixture(little = true, color = 1) {
  const tiff = new Uint8Array(110),
    view = new DataView(tiff.buffer)
  const u16 = (p, v) => view.setUint16(p, v, little)
  const u32 = (p, v) => view.setUint32(p, v, little)
  u16(0, little ? 0x4949 : 0x4d4d)
  u16(2, 42)
  u32(4, 8)
  u16(8, 3)
  function entry(p, tag, type, count, value) {
    u16(p, tag)
    u16(p + 2, type)
    u32(p + 4, count)
    u32(p + 8, value)
  }
  entry(10, 0x010f, 2, 10, 50)
  entry(22, 0x0110, 2, 8, 60)
  entry(34, 0x8769, 4, 1, 70)
  tiff.set(new TextEncoder().encode('Panasonic\0'), 50)
  tiff.set(new TextEncoder().encode('DC-S5M2\0'), 60)
  u16(70, 1)
  entry(72, 0xa001, 3, 1, 0)
  u16(80, color)
  const segment = new Uint8Array(6 + tiff.length)
  segment.set([69, 120, 105, 102, 0, 0])
  segment.set(tiff, 6)
  const jpg = new Uint8Array(segment.length + 8),
    length = segment.length + 2
  jpg.set([255, 216, 255, 225, length >> 8, length & 255])
  jpg.set(segment, 6)
  jpg.set([255, 217], jpg.length - 2)
  return jpg
}

test('reads both TIFF byte orders without inferring input style', () => {
  for (const little of [true, false]) {
    const metadata = parsePhotoMetadata(fixture(little))
    assert.equal(metadata.camera_make, 'Panasonic')
    assert.equal(metadata.camera_model, 'DC-S5M2')
    assert.equal(metadata.color_space, 'sRGB')
    assert.equal(metadata.base_photo_style, undefined)
    assert.deepEqual(Object.keys(metadata).sort(), [
      'camera_make',
      'camera_model',
      'color_space',
      'embedded_icc',
    ])
  }
})

test('missing, truncated and invalid offsets are safe and do not read unrelated fields', () => {
  const jpg = fixture()
  for (let length = 0; length < jpg.length; length++) {
    assert.doesNotThrow(() => parsePhotoMetadata(jpg.subarray(0, length)))
  }
  const damaged = fixture()
  damaged.set([255, 255, 255, 255], 12 + 18)
  assert.equal(parsePhotoMetadata(damaged).camera_make, '')
  assert.equal(parsePhotoMetadata(new Uint8Array([1, 2, 3, 4])).color_space, 'unknown')
})

test('uncalibrated and ICC data produce guidance without automatic correction', () => {
  assert.equal(parsePhotoMetadata(fixture(true, 65535)).color_space, 'uncalibrated')
  const bytes = new Uint8Array([
    255,
    216,
    255,
    226,
    0,
    16,
    ...new TextEncoder().encode('ICC_PROFILE\0'),
    1,
    1,
    255,
    217,
  ])
  assert.equal(parsePhotoMetadata(bytes).embedded_icc, true)
  assert.match(photoMetadataNotes(parsePhotoMetadata(bytes)).warning, /ICC/)
  assert.match(photoMetadataNotes().input, /确认输入/)
})
