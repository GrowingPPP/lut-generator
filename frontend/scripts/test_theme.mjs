import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  createThemeController,
  normalizeThemePreference,
  resolveTheme,
} from '../src/lib/theme.js'

function browser({ saved = null, dark = false, storageFailure, mediaFailure, legacy = false } = {}) {
  const attributes = new Map()
  const events = new Map()
  const mediaListeners = new Set()
  const writes = []
  const storage = {
    getItem(key) {
      assert.equal(key, THEME_STORAGE_KEY)
      if (storageFailure === 'read') throw new Error('Storage unavailable')
      return saved
    },
    setItem(key, value) {
      if (storageFailure === 'write') throw new Error('Storage unavailable')
      saved = value
      writes.push([key, value])
    },
  }
  const media = { matches: dark }
  if (legacy) {
    media.addListener = listener => mediaListeners.add(listener)
    media.removeListener = listener => mediaListeners.delete(listener)
  } else {
    media.addEventListener = (type, listener) => { assert.equal(type, 'change'); mediaListeners.add(listener) }
    media.removeEventListener = (type, listener) => { assert.equal(type, 'change'); mediaListeners.delete(listener) }
  }
  const document = { documentElement: { setAttribute: (name, value) => attributes.set(name, value) } }
  const window = {
    document,
    matchMedia(query) {
      assert.equal(query, '(prefers-color-scheme: dark)')
      if (mediaFailure) throw new Error('Media unavailable')
      return media
    },
    addEventListener(type, listener) {
      if (!events.has(type)) events.set(type, new Set())
      events.get(type).add(listener)
    },
    removeEventListener(type, listener) { events.get(type)?.delete(listener) },
  }
  Object.defineProperty(window, 'localStorage', {
    get() {
      if (storageFailure === 'access') throw new Error('Storage unavailable')
      return storage
    },
  })
  return {
    window, document, attributes, writes, events, mediaListeners, storage,
    changeSystem(matches) {
      media.matches = matches
      for (const listener of mediaListeners) listener({ matches })
    },
    storageEvent(value, { key = THEME_STORAGE_KEY, storageArea = storage } = {}) {
      for (const listener of events.get('storage') || []) listener({ key, newValue: value, storageArea })
    },
  }
}

function initialized(options) {
  const environment = browser(options)
  const controller = createThemeController(environment)
  controller.initialize()
  return { ...environment, controller }
}

test('theme choices expose all four Chinese names with strict preference validation', () => {
  assert.deepEqual(THEME_OPTIONS.map(({ value, label }) => [value, label]), [
    ['dark', '深色'], ['gray', '中性灰'], ['light', '浅色'], ['system', '跟随系统'],
  ])
  for (const value of [null, undefined, '', 'Dark', 'sepia', true, 1, {}, ['light']]) {
    assert.equal(normalizeThemePreference(value), 'dark')
  }
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('gray', false), 'gray')
})

test('first visit defaults to dark independent of the system appearance', () => {
  for (const dark of [false, true]) {
    const { controller, attributes, writes } = initialized({ dark })
    assert.equal(controller.getPreference(), 'dark')
    assert.equal(controller.getResolvedTheme(), 'dark')
    assert.equal(attributes.get('data-theme'), 'dark')
    assert.equal(attributes.get('data-theme-preference'), 'dark')
    assert.deepEqual(writes, [])
  }
})

test('each saved preference restores without writing or changing the preference', () => {
  for (const { value } of THEME_OPTIONS) {
    for (const dark of [false, true]) {
      const { controller, attributes, writes } = initialized({ saved: value, dark })
      assert.equal(controller.getPreference(), value)
      assert.equal(attributes.get('data-theme'), resolveTheme(value, dark))
      assert.equal(attributes.get('data-theme-preference'), value)
      assert.deepEqual(writes, [])
    }
  }
})

test('choosing a theme immediately applies and persists the preference', () => {
  const { controller, attributes, writes } = initialized()
  for (const { value } of THEME_OPTIONS) {
    controller.setPreference(value)
    assert.equal(controller.getPreference(), value)
    assert.equal(attributes.get('data-theme'), resolveTheme(value, false))
    assert.deepEqual(writes.at(-1), [THEME_STORAGE_KEY, value])
  }
  controller.setPreference('invalid')
  assert.equal(attributes.get('data-theme'), 'dark')
  assert.deepEqual(writes.at(-1), [THEME_STORAGE_KEY, 'dark'])
})

test('system mode follows live appearance changes without overwriting the stored choice', () => {
  const { controller, attributes, writes, changeSystem } = initialized({ saved: 'system' })
  assert.equal(attributes.get('data-theme'), 'light')
  changeSystem(true)
  assert.equal(controller.getResolvedTheme(), 'dark')
  assert.equal(attributes.get('data-theme'), 'dark')
  changeSystem(false)
  assert.equal(attributes.get('data-theme'), 'light')
  assert.equal(attributes.get('data-theme-preference'), 'system')
  assert.deepEqual(writes, [])
})

test('explicit themes remain stable and switching to system uses its latest appearance', () => {
  const { controller, attributes, changeSystem } = initialized()
  for (const value of ['dark', 'gray', 'light']) {
    controller.setPreference(value)
    changeSystem(false)
    changeSystem(true)
    assert.equal(attributes.get('data-theme'), value)
  }
  controller.setPreference('system')
  assert.equal(attributes.get('data-theme'), 'dark')
})

test('legacy matchMedia listeners support system changes and cleanup', () => {
  const { controller, attributes, mediaListeners, changeSystem } = initialized({ saved: 'system', legacy: true })
  assert.equal(mediaListeners.size, 1)
  changeSystem(true)
  assert.equal(attributes.get('data-theme'), 'dark')
  controller.dispose()
  assert.equal(mediaListeners.size, 0)
})

for (const storageFailure of ['access', 'read', 'write']) {
  test(`storage ${storageFailure} failure permits switching within the page`, () => {
    const { controller, attributes } = initialized({ saved: 'gray', storageFailure })
    assert.equal(controller.getPreference(), storageFailure === 'write' ? 'gray' : 'dark')
    assert.doesNotThrow(() => controller.setPreference('light'))
    assert.equal(controller.getPreference(), 'light')
    assert.equal(attributes.get('data-theme'), 'light')
  })
}

test('missing or failing media APIs resolve system to dark without losing the preference', () => {
  const failed = initialized({ saved: 'system', mediaFailure: true })
  assert.equal(failed.controller.getPreference(), 'system')
  assert.equal(failed.attributes.get('data-theme'), 'dark')
  const environment = browser({ saved: 'system' })
  delete environment.window.matchMedia
  const controller = createThemeController(environment)
  assert.doesNotThrow(() => controller.initialize())
  assert.equal(controller.getPreference(), 'system')
  assert.equal(controller.getResolvedTheme(), 'dark')
  const withoutBrowser = createThemeController({ window: null })
  assert.doesNotThrow(() => withoutBrowser.setPreference('gray'))
  assert.equal(withoutBrowser.getResolvedTheme(), 'gray')
})

test('cross-tab events synchronize all subscribers without writing back', () => {
  const { controller, attributes, writes, storageEvent, changeSystem } = initialized()
  const seen = []
  const unsubscribe = controller.subscribe(() => seen.push(controller.getPreference()))
  storageEvent('gray')
  assert.equal(attributes.get('data-theme'), 'gray')
  storageEvent('system')
  changeSystem(true)
  assert.equal(attributes.get('data-theme'), 'dark')
  assert.equal(controller.getPreference(), 'system')
  assert.deepEqual(seen, ['gray', 'system'])
  assert.deepEqual(writes, [])
  unsubscribe()
  storageEvent('light')
  assert.equal(attributes.get('data-theme'), 'light')
  assert.deepEqual(seen, ['gray', 'system'])
})

test('storage removal, clearing and invalid values safely return to dark', () => {
  const { controller, attributes, storageEvent } = initialized({ saved: 'light' })
  for (const value of [null, 'invalid']) {
    controller.setPreference('gray')
    storageEvent(value)
    assert.equal(controller.getPreference(), 'dark')
  }
  controller.setPreference('light')
  storageEvent(null, { key: null })
  assert.equal(attributes.get('data-theme'), 'dark')
})

test('unrelated keys and other storage areas do not change the theme', () => {
  const { controller, storageEvent } = initialized({ saved: 'gray' })
  storageEvent('light', { key: 'workspace' })
  storageEvent('light', { storageArea: {} })
  assert.equal(controller.getPreference(), 'gray')
})

test('initialization is idempotent and disposal removes browser listeners', () => {
  const { controller, events, mediaListeners, storageEvent } = initialized()
  controller.initialize()
  controller.getPreference()
  assert.equal(events.get('storage').size, 1)
  assert.equal(mediaListeners.size, 1)
  const seen = []
  controller.subscribe(() => seen.push(controller.getPreference()))
  storageEvent('light')
  storageEvent('light')
  assert.deepEqual(seen, ['light'])
  controller.dispose()
  assert.equal(events.get('storage').size, 0)
  assert.equal(mediaListeners.size, 0)
})

test('early HTML initialization matches the runtime and precedes app and font loading', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const match = html.match(/<script>\s*([\s\S]*?)<\/script>/)
  assert.ok(match, 'An early synchronous theme initializer is present')
  assert.ok(match.index < html.indexOf('fonts.googleapis.com'))
  assert.ok(match.index < html.indexOf('type="module"'))
  const cases = []
  for (const saved of [null, 'dark', 'gray', 'light', 'system', 'invalid']) {
    for (const dark of [false, true]) cases.push({ saved, dark })
  }
  for (const storageFailure of ['access', 'read']) cases.push({ saved: 'light', storageFailure })
  cases.push({ saved: 'system', mediaFailure: true })
  for (const options of cases) {
    const early = browser(options)
    runInNewContext(match[1], { window: early.window, document: early.document })
    const runtime = initialized(options)
    assert.deepEqual([...early.attributes], [...runtime.attributes], JSON.stringify(options))
  }
})
