import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryCoverStorage, COVER_MAX_BYTES, COVER_BUDGET_BYTES, photoCover } from '../src/lib/assetCovers.js'

const jpeg = size => new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
test('covers are isolated by owner and asset; replacement and removal preserve other covers', async () => {
  const storage = createMemoryCoverStorage(), a = jpeg(10), b = jpeg(20)
  await storage.put('alice', '1', a); await storage.put('bob', '1', b); await storage.put('alice', '2', b)
  await storage.put('alice', '1', b)
  assert.equal((await storage.get('alice', '1')).size, 20)
  await storage.put('alice', '1', null)
  assert.equal(await storage.get('alice', '1'), null)
  assert.equal((await storage.get('bob', '1')).size, 20)
  assert.equal((await storage.get('alice', '2')).size, 20)
  await assert.rejects(storage.get('', '1'), /有效账号/)
})
test('capacity rejection is atomic and replacement reuses its prior allocation', async () => {
  const storage = createMemoryCoverStorage(), full = jpeg(COVER_MAX_BYTES)
  const count = Math.floor(COVER_BUDGET_BYTES / COVER_MAX_BYTES)
  for (let i = 0; i < count; i++) await storage.put('alice', i + 1, full)
  await storage.put('alice', 1, full)
  await assert.rejects(storage.put('alice', 'overflow', full), /12MB/)
  assert.equal(await storage.get('alice', 'overflow'), null)
  assert.equal((await storage.get('alice', 1)).size, COVER_MAX_BYTES)
  await storage.put('bob', 'other-owner', full)
  await assert.rejects(storage.put('alice', 1, jpeg(COVER_MAX_BYTES + 1)), /300KB/)
  assert.equal((await storage.get('alice', 1)).size, COVER_MAX_BYTES)
})
test('deleted assets reject late cover saves and cannot be revived by a stale removal', async () => {
  const storage = createMemoryCoverStorage()
  await storage.put('alice', '1', jpeg(10))
  await storage.put('alice', '1', null, { retired: true })
  await assert.rejects(storage.put('alice', '1', jpeg(20)), /作品已删除/)
  await assert.rejects(storage.put('alice', '1', null), /作品已删除/)
  assert.equal(await storage.get('alice', '1'), null)
})
test('unsupported or excessive source files are rejected before image decoding', async () => {
  await assert.rejects(photoCover(new Blob(['<svg/>'], { type: 'image/svg+xml' })), /JPEG/)
  await assert.rejects(photoCover({ type: 'image/jpeg', size: 33 * 1024 * 1024 }), /32MB/)
})
