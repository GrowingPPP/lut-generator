import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeRestoredMedia } from '../src/lib/sampleMedia.js'

const sample = (id, changes = {}) => ({
  id,
  source_digest: `source-${id}`,
  preview_digest: `preview-${id}`,
  input_contract: { base_photo_style: 'STD', output_encoding: 'sRGB', tone_map: 1 },
  ...changes,
})
const media = (metadata, changes = {}) => ({ metadata: structuredClone(metadata), canvas: {}, file: null, ...changes })

test('late cache restoration keeps the latest bound original and returns an independent map', () => {
  const source = sample('one')
  const bound = media(source, { file: new Blob(['original']) })
  const cached = media(source)
  const current = new Map([['one', bound]])
  const restored = new Map([['one', cached]])
  const merged = mergeRestoredMedia(current, restored, [source])
  assert.notEqual(merged, current)
  assert.equal(merged.get('one'), bound)
  assert.equal(merged.get('one').file, bound.file)
  assert.equal(current.get('one'), bound)
  assert.equal(restored.get('one'), cached)
})

test('restoration fills missing media while preserving each current matching photo', () => {
  const sources = [sample('one'), sample('two'), sample('three')]
  const bound = media(sources[0], { file: new Blob(['original']) })
  const present = media(sources[1])
  const third = media(sources[2])
  const merged = mergeRestoredMedia(new Map([['one', bound], ['two', present]]),
    new Map([['one', media(sources[0])], ['three', third]]), sources)
  assert.deepEqual([...merged.keys()], ['one', 'two', 'three'])
  assert.equal(merged.get('one'), bound)
  assert.equal(merged.get('two'), present)
  assert.equal(merged.get('three'), third)
})

test('removed photos cannot return from current media or a late cached restoration', () => {
  const kept = sample('kept'), removed = sample('removed')
  const present = media(kept)
  const merged = mergeRestoredMedia(new Map([['kept', present], ['removed', media(removed)]]),
    new Map([['removed', media(removed)]]), [kept])
  assert.deepEqual([...merged.entries()], [['kept', present]])
  assert.equal(mergeRestoredMedia(new Map([['removed', media(removed)]]), new Map(), []).size, 0)
})

test('changed source, input or preview identity rejects both stale current and restored media', () => {
  const original = sample('one')
  for (const changed of [
    { source_digest: 'new-source' },
    { input_contract: { ...original.input_contract, base_photo_style: 'NAT' } },
    { input_contract: { ...original.input_contract, output_encoding: 'Rec709' } },
    { input_contract: { ...original.input_contract, tone_map: 0.5 } },
    { preview_digest: 'new-preview' },
  ]) {
    const currentSample = sample('one', changed)
    const merged = mergeRestoredMedia(new Map([['one', media(original)]]),
      new Map([['one', media(original)]]), [currentSample])
    assert.equal(merged.size, 0, JSON.stringify(changed))
  }
})

test('a stale current object yields to a restored object matching the current identity', () => {
  const previous = sample('one'), currentSample = sample('one', { preview_digest: 'updated-preview' })
  const matching = media(currentSample)
  const merged = mergeRestoredMedia(new Map([['one', media(previous)]]),
    new Map([['one', matching]]), [currentSample])
  assert.equal(merged.get('one'), matching)
})

test('input contract identity does not depend on object key order but includes all recorded fields', () => {
  const source = sample('one')
  const reordered = media({ ...source, input_contract: { tone_map: 1, output_encoding: 'sRGB', base_photo_style: 'STD' } })
  assert.equal(mergeRestoredMedia(new Map(), new Map([['one', reordered]]), [source]).get('one'), reordered)
  const incomplete = media({ ...source, input_contract: { base_photo_style: 'STD', output_encoding: 'sRGB' } })
  assert.equal(mergeRestoredMedia(new Map(), new Map([['one', incomplete]]), [source]).size, 0)
})

test('legacy previews with no preview digest remain usable only when both identities lack it', () => {
  const legacy = sample('one')
  delete legacy.preview_digest
  const cached = media(legacy)
  assert.equal(mergeRestoredMedia(new Map(), new Map([['one', cached]]), [legacy]).get('one'), cached)
  const changed = sample('one')
  assert.equal(mergeRestoredMedia(new Map(), new Map([['one', cached]]), [changed]).size, 0)
  assert.equal(mergeRestoredMedia(new Map(), new Map([['one', media(changed)]]), [legacy]).size, 0)
})

test('missing source identity or mismatched metadata id cannot bind a guessed source', () => {
  const source = sample('one')
  const wrongId = media({ ...source, id: 'two' })
  assert.equal(mergeRestoredMedia(new Map([['one', wrongId]]), new Map(), [source]).size, 0)
  for (const source_digest of [undefined, null, '']) {
    const unknown = sample('one', { source_digest })
    assert.equal(mergeRestoredMedia(new Map([['one', media(unknown)]]), new Map(), [unknown]).size, 0)
  }
  assert.equal(mergeRestoredMedia(new Map([['one', {}]]), new Map(), [source]).size, 0)
})
