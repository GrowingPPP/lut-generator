import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizedPhotoMetadata, normalizePhoto } from '../src/lib/photoApi.js'
import { sampleIsNormalized, sampleMatches } from '../src/lib/samples.js'
import { photoMetadataNotes } from '../src/lib/photoMetadata.js'
import { inputContract } from '../src/lib/styleRecipe.js'

const digest = 'a'.repeat(64)
const metadata = {
  source_digest: digest, width: 2048, height: 1365, source_width: 6000, source_height: 4000,
  color_management: { version: 1, input_style: 'STD', status: 'converted_srgb', working_space: 'sRGB', warning: '' },
}

test('normalization metadata must match source, encoding and bounded dimensions', () => {
  assert.equal(normalizedPhotoMetadata(metadata, 'STD', digest), metadata)
  for (const changed of [
    { source_digest: 'b'.repeat(64) }, { width: 2049 }, { height: 0 }, { source_width: 100000 },
    { color_management: { ...metadata.color_management, version: 0 } },
    { color_management: { ...metadata.color_management, input_style: 'VLOG' } },
  ]) assert.throws(() => normalizedPhotoMetadata({ ...metadata, ...changed }, 'STD', digest))
})

test('original normalization requires exact oriented source dimensions and keeps the 64MP limit', () => {
  const original = { ...metadata, width: 6000, height: 4000 }
  assert.equal(normalizedPhotoMetadata(original, 'STD', digest, 'original'), original)
  assert.throws(() => normalizedPhotoMetadata(original, 'STD', digest))
  assert.throws(() => normalizedPhotoMetadata(original, 'STD', digest, 'preview'))
  for (const changed of [
    { width: 2048, height: 1365 }, { width: 6000, height: 3999 },
    { width: 4000, height: 6000 }, { width: 0 }, { width: 6000.5 },
    { width: 8001, height: 8000, source_width: 8001, source_height: 8000 },
    { source_digest: 'b'.repeat(64) },
  ]) assert.throws(() => normalizedPhotoMetadata({ ...original, ...changed }, 'STD', digest, 'original'))
  assert.throws(() => normalizedPhotoMetadata(original, 'STD', digest, 'unbounded'))
})

function normalizedResponse(resultMetadata) {
  return new Response(new Blob(['normalized png'], { type: 'image/png' }), {
    status: 200, headers: { 'X-Photo-Metadata': JSON.stringify(resultMetadata) },
  })
}

test('normalizePhoto forwards explicit original resolution and AbortSignal without changing default preview', async t => {
  const file = Object.assign(new Blob(['source'], { type: 'image/jpeg' }), { name: 'source.jpg' })
  const controller = new AbortController()
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    requests.push({ url, request })
    return normalizedResponse(request.body.get('resolution') === 'original'
      ? { ...metadata, width: 6000, height: 4000 } : metadata)
  })
  const original = await normalizePhoto(file, 'STD', digest, { resolution: 'original', signal: controller.signal })
  assert.equal(original.metadata.width, 6000)
  assert.equal(await original.blob.text(), 'normalized png')
  assert.equal(requests[0].url, '/api/photos/normalize')
  assert.equal(requests[0].request.signal, controller.signal)
  assert.equal(requests[0].request.credentials, 'include')
  assert.equal(requests[0].request.body.get('resolution'), 'original')
  assert.equal(requests[0].request.body.get('input_style'), 'STD')
  assert.equal(requests[0].request.body.get('file').name, 'source.jpg')
  const preview = await normalizePhoto(file, 'STD', digest)
  assert.equal(preview.metadata.width, 2048)
  assert.equal(requests[1].request.body.get('resolution'), 'preview')
})

test('normalizePhoto exposes request cancellation and rejects a downscaled original response', async t => {
  const file = Object.assign(new Blob(['source']), { name: 'source.jpg' })
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', (_url, request) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  }))
  const pending = normalizePhoto(file, 'STD', digest, { resolution: 'original', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  t.mock.method(globalThis, 'fetch', async () => normalizedResponse(metadata))
  await assert.rejects(normalizePhoto(file, 'STD', digest, { resolution: 'original' }), /来源不一致/)
})

test('old previews and mismatched normalization cannot be measured as compatible samples', () => {
  const sample = { input_contract: inputContract({ base_photo_style: 'STD' }), color_management: metadata.color_management }
  assert.equal(sampleIsNormalized(sample), true)
  assert.equal(sampleMatches(sample, { base_photo_style: 'STD' }), true)
  assert.equal(sampleMatches({ ...sample, color_management: undefined }, { base_photo_style: 'STD' }), false)
  assert.equal(sampleMatches(sample, { base_photo_style: 'VLOG' }), false)
  assert.equal(sampleMatches({ ...sample, color_management: { ...metadata.color_management, input_style: 'VLOG' } }, { base_photo_style: 'STD' }), false)
})

test('normalized color metadata explains conversion, assumptions and log preservation', () => {
  assert.match(photoMetadataNotes(metadata).color, /ICC.*sRGB/)
  assert.equal(photoMetadataNotes(metadata).warning, '')
  const assumed = photoMetadataNotes({ color_management: { ...metadata.color_management, status: 'assumed_srgb', warning: '按 sRGB 解释' } })
  assert.match(assumed.color, /按 sRGB/)
  assert.equal(assumed.warning, '按 sRGB 解释')
  assert.match(photoMetadataNotes({ color_management: { ...metadata.color_management, input_style: 'VLOG', status: 'preserved_vlog' } }).color, /V-Log/)
  assert.match(photoMetadataNotes({ color_management: { ...metadata.color_management, status: 'converted_adobe_rgb' } }).color, /Adobe RGB.*sRGB/)
})
