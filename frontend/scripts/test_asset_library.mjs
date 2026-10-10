import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assetMatches,
  libraryQuery,
  metadataPatch,
  normalizeAsset,
  parseTags,
} from '../src/lib/assetLibrary.js'

const asset = {
  id: 1,
  name: 'Night walk',
  description: '阴天街拍',
  tags: ['低饱和', 'City'],
  group: '旅行',
  favorite: true,
  cover_id: 'amber',
  created_at: '2026-01-01',
  params: { base_photo_style: 'NAT' },
}
test('query serialization retains false, ungrouped and literal search text', () => {
  assert.deepEqual(
    libraryQuery({
      q: '  50%_!  ',
      favorite: false,
      group: 'none',
      kind: 'full_snapshot',
      input: 'NAT',
      sort: 'name_asc',
    }),
    {
      q: '50%_!',
      favorite: 'false',
      group: '',
      kind: 'full_snapshot',
      input: 'NAT',
      sort: 'name_asc',
    },
  )
  assert.deepEqual(libraryQuery({ group: 'group:旅行', favorite: 'true' }), {
    group: '旅行',
    favorite: 'true',
  })
  assert.deepEqual(libraryQuery(), {})
})
test('legacy assets retain useful defaults', () => {
  assert.deepEqual(normalizeAsset({ name: 'old', created_at: '2025-01-01' }), {
    name: 'old',
    created_at: '2025-01-01',
    kind: 'full_snapshot',
    tags: [],
    group: null,
    favorite: false,
    cover_id: 'engine',
    updated_at: '2025-01-01',
  })
})
test('metadata patch submits only changed fields and has no grading content', () => {
  const draft = { ...asset, tags: '低饱和，City' }
  assert.deepEqual(metadataPatch(asset, draft), {})
  assert.deepEqual(
    metadataPatch(asset, {
      ...draft,
      description: '室内人像',
      favorite: false,
    }),
    { description: '室内人像', favorite: false },
  )
  assert.deepEqual(metadataPatch(asset, { ...draft, group: ' ' }), {
    group: null,
  })
})
test('tags are trimmed, deduplicated and bounded', () => {
  assert.deepEqual(parseTags(' City，city, 人像\n夜景'), [
    'City',
    '人像',
    '夜景',
  ])
  assert.throws(() =>
    parseTags(Array.from({ length: 13 }, (_, i) => String(i))),
  )
  assert.throws(() => parseTags(['a'.repeat(25)]))
  assert.throws(() => parseTags([true]))
  assert.throws(() => parseTags(['a\u0000']))
})
test('editing other metadata preserves existing tags containing input separators', () => {
  const original = { ...asset, tags: ['夜,雨', '冷，暖'] }
  const draft = { ...original, name: '新名称', tags: original.tags.join('，') }
  assert.deepEqual(metadataPatch(original, draft), { name: '新名称' })
  assert.deepEqual(metadataPatch(original, { ...draft, tags: '雨天，人像' }), {
    name: '新名称',
    tags: ['雨天', '人像'],
  })
})
test('library matches names, scenes, tags and combined facets', () => {
  for (const q of ['night', '阴天', 'city'])
    assert.equal(assetMatches(asset, { q }), true)
  assert.equal(
    assetMatches(asset, {
      kind: 'full_snapshot',
      input: 'NAT',
      favorite: 'true',
      group: 'group:旅行',
    }),
    true,
  )
  assert.equal(assetMatches(asset, { favorite: 'false' }), false)
  assert.equal(assetMatches(asset, { group: 'none' }), false)
  assert.equal(assetMatches(asset, { input: 'VLOG' }), false)
})
