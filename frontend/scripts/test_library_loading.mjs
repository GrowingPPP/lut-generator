import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import * as React from 'react'

const require = createRequire(import.meta.url)
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/LibraryView.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  loader: { '.css': 'empty' },
  plugins: [{ name: 'library-api-boundary', setup(builder) {
    builder.onResolve({ filter: /lib\/api\.js$/ }, () => ({ path: 'api', namespace: 'library-api-boundary' }))
    builder.onLoad({ filter: /.*/, namespace: 'library-api-boundary' }, () => ({ contents: `
      export const listLuts = (...args) => __libraryApi.list(...args);
      export const getLibrarySummary = () => __libraryApi.summary();
      export const deleteLut = () => { throw new Error('unexpected delete'); };
      export const downloadLut = () => { throw new Error('unexpected download'); };
      export const listLutRevisions = () => { throw new Error('unexpected revision request'); };
      export const updateLutMetadata = () => { throw new Error('unexpected metadata update'); };
    ` }))
  } }],
})

function findElement(element, predicate) {
  if (!element?.props) return null
  if (predicate(element)) return element
  return [element.props.children].flat(Infinity).map(child => findElement(child, predicate)).find(Boolean)
}

// Execute the actual component state, debounce, effect dependencies and API
// errors. Fake time makes request counts deterministic without sleeping.
function libraryHost(list) {
  const slots = [], timers = new Map(), requests = []
  let cursor = 0, timerId = 0, dirty = false, pending = [], tree
  const changed = (prior, next) => !prior || next.some((value, index) => !Object.is(value, prior[index]))
  const hooks = {
    ...React,
    useContext: () => ({ confirm: async () => true }),
    useState(initial) {
      const index = cursor++
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.update = update => {
          const next = typeof update === 'function' ? update(slot.value) : update
          if (!Object.is(next, slot.value)) { slot.value = next; dirty = true }
        }
        slots[index] = slot
      }
      return [slots[index].value, slots[index].update]
    },
    useMemo(factory, dependencies) {
      const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) slots[index] = { value: factory(), dependencies }
      return slots[index].value
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) {
        const prior = slots[index]
        slots[index] = { dependencies }
        pending.push(() => { prior?.cleanup?.(); slots[index].cleanup = callback() })
      }
    },
  }
  hooks.useRef = initial => hooks.useState(() => ({ current: initial }))[0]
  hooks.useCallback = (callback, dependencies) => hooks.useMemo(() => callback, dependencies)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__libraryApi', 'setTimeout', 'clearTimeout', 'document', bundle.outputFiles[0].text)(
    name => name === 'react' ? hooks : require(name), module, module.exports,
    { list: filters => { requests.push(structuredClone(filters)); return list(filters, requests.length) },
      summary: async () => ({ total: 0, groups: [] }) },
    callback => { timers.set(++timerId, callback); return timerId }, id => timers.delete(id),
    { activeElement: null, body: {} },
  )
  const render = () => {
    cursor = 0; pending = []; dirty = false
    tree = module.exports.default({ onPreview() {} })
    for (const effect of pending) effect()
  }
  render()
  return {
    requests,
    get tree() { return tree },
    async settle() {
      for (let turn = 0; turn < 10; turn++) {
        await Promise.resolve()
        if (dirty) render()
      }
    },
    async advanceSearchDelay() {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) callback()
      await this.settle()
    },
    async search(value) {
      findElement(tree, element => element.type === 'input' && element.props.type === 'search').props.onChange({ target: { value } })
      await this.settle()
    },
    async click(label) {
      const button = findElement(tree, element => element.type === 'button' && element.props.children === label)
      assert.ok(button, `missing button: ${label}`)
      button.props.onClick()
      await this.settle()
    },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

test('an initial library failure remains visible until explicit retry, even after the search delay', async () => {
  const host = libraryHost(async (_filters, attempt) => {
    if (attempt === 1) throw new Error('service unavailable')
    return []
  })
  await host.settle()
  assert.equal(host.requests.length, 1)
  assert.ok(findElement(host.tree, element => element.props.role === 'alert'))
  await host.advanceSearchDelay()
  assert.equal(host.requests.length, 1)
  assert.ok(findElement(host.tree, element => element.props.role === 'alert'))
  await host.click('重新加载')
  assert.equal(host.requests.length, 2)
  assert.equal(findElement(host.tree, element => element.props.role === 'alert'), undefined)
  host.unmount()
})

test('quick search edits coalesce into one request and repeating the same value adds none', async () => {
  const host = libraryHost(async () => [])
  await host.settle()
  await host.advanceSearchDelay()
  assert.equal(host.requests.length, 1)
  await host.search('暖')
  await host.search('暖光')
  assert.equal(host.requests.length, 1)
  await host.advanceSearchDelay()
  assert.equal(host.requests.length, 2)
  assert.equal(host.requests[1].q, '暖光')
  await host.search('暖光')
  await host.advanceSearchDelay()
  assert.equal(host.requests.length, 2)
  host.unmount()
})

test('clearing an active search reloads once without a second request when debounce settles', async () => {
  const host = libraryHost(async () => [])
  await host.settle()
  await host.advanceSearchDelay()
  await host.search('人像')
  await host.advanceSearchDelay()
  assert.equal(host.requests.length, 2)
  await host.click('清除筛选')
  assert.equal(host.requests.length, 3)
  assert.equal(host.requests.at(-1).q, '')
  await host.advanceSearchDelay()
  assert.equal(host.requests.length, 3)
  host.unmount()
})
