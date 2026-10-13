import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocationStore, parseLocation, locationHash, resolveProjectLocation } from '../src/lib/appLocation.js'

const id = '4bc192f0-32cb-4097-bc55-120e6b273ee1'
test('location allows viewing identifiers only, preserves section anchors and rejects malformed project IDs', () => {
  assert.equal(parseLocation('#features').view, 'landing')
  assert.equal(parseLocation('#/library').view, 'library')
  assert.equal(parseLocation(`#/create?project=${id.toUpperCase()}&step=adjust`).projectId, id)
  assert.equal(parseLocation('#/create?project=../secret&step=unknown').invalidProject, true)
  assert.equal(parseLocation('#/create?step=unknown').step, null)
  const hash = locationHash({ view: 'generate', projectId: id, step: 'save', prompt: 'private', token: 'secret' })
  assert.equal(hash, `#/create?project=${id}&step=save`)
  assert.equal(locationHash({ view: 'generate', projectId: 'bogus', step: 'wrong' }), '#/create')
})
test('user navigation pushes, restoration replaces, and back/forward event pairs publish once', () => {
  const events = new Map(), calls = []
  const browser = { location: { hash: '#/' },
    history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_, __, hash) => { calls.push(method); browser.location.hash = hash }])),
    addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) }
  const store = createLocationStore(browser), observed = []
  const off = store.subscribe(route => observed.push(route))
  store.navigate({ view: 'generate', projectId: id, step: 'photos' }, { replace: true })
  store.navigate({ view: 'generate', projectId: id, step: 'adjust' })
  store.navigate({ view: 'library' })
  assert.deepEqual(calls, ['replaceState', 'pushState', 'pushState'])
  browser.location.hash = `#/create?project=${id}&step=adjust`
  events.get('popstate')(); events.get('hashchange')()
  assert.equal(observed.length, 4)
  assert.equal(store.get().step, 'adjust'); assert.equal(store.get().external, true)
  off(); assert.equal(events.size, 0)
})
test('a project URL cannot authorize another owner, resurrect a tombstone or create a missing project', async () => {
  let writes = 0
  const options = { user: 'alice', listLocal: async () => [{ id, user_id: 'bob' }],
    listRemote: async () => [], deletedIds: async () => [], create: () => writes++ }
  assert.equal(await resolveProjectLocation(id, options), null)
  assert.equal(await resolveProjectLocation(id, { ...options, listLocal: async () => [{ id, user_id: 'alice' }], deletedIds: async () => [id] }), null)
  assert.equal(writes, 0)
})
test('owned local drafts survive remote unavailability, but unknown projects require a successful ownership lookup', async () => {
  const offline = async () => { throw new Error('network offline') }
  const options = { user: 'alice', listLocal: async () => [{ id, user_id: 'alice', name: 'local' }], listRemote: offline, deletedIds: async () => [] }
  assert.equal((await resolveProjectLocation(id, options)).name, 'local')
  await assert.rejects(resolveProjectLocation(id, { ...options, listLocal: async () => [] }), /offline/)
  await assert.rejects(resolveProjectLocation(id, { ...options, listLocal: async () => null }), /本机项目/)
  assert.equal((await resolveProjectLocation(id, { ...options, listLocal: async () => [], listRemote: async () => [{ id, name: 'remote' }] })).name, 'remote')
})
