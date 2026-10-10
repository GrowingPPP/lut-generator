import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizedPhotoMetadata } from '../src/lib/photoApi.js'
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
})
