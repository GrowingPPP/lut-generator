import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import * as React from 'react'
import { createWorkspace } from '../src/lib/workspace.js'
import { defaultParams } from '../src/lib/lutEngine.js'

const require = createRequire(import.meta.url)
const apiNames = ['createLut', 'chatSession', 'listSessions', 'createSession', 'deleteSession', 'updateSession', 'listMessages',
  'saveTextFile', 'cameraFileName', 'listWorkspaces', 'createWorkspace', 'updateWorkspace', 'deleteWorkspace',
  'listVersions', 'createVersion', 'renameVersion', 'deleteVersion', 'applyLut', 'validateWorkspace', 'updateLut',
  'getAutoReport', 'analyzePhotoSubjects']
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/GenerateView.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  loader: { '.css': 'empty' }, define: { 'import.meta.hot': 'undefined' },
  plugins: [{ name: 'preview-test-boundaries', setup(builder) {
    const boundary = (filter, namespace, contents) => {
      builder.onResolve({ filter }, args => ({ path: args.path, namespace }))
      builder.onLoad({ filter: /.*/, namespace }, () => ({ contents }))
    }
    boundary(/\?lazy-url$/, 'preview-lazy', `export default '/not-loaded-in-node';`)
    boundary(/hooks\/useWorkspace\.js$/, 'preview-workspace', 'export default () => __editor;')
    boundary(/hooks\/usePreview\.js$/, 'preview-renderer', 'export default () => ({ setSplit() {}, error: null });')
    boundary(/hooks\/useAutoRetouchController\.js$/, 'preview-ai', 'export default () => ({});')
    boundary(/lib\/preview\.js$/, 'preview-canvas', `export const makeTestImage = () => ({ width: 800, height: 560 }); export const makeThumb = () => '';`)
    boundary(/lib\/api\.js$/, 'preview-api', apiNames.map(name => `export const ${name} = (...args) => __api(${JSON.stringify(name)}, ...args);`).join('\n'))
  } }],
})

function findElement(element, predicate) {
  if (!element?.props) return undefined
  if (predicate(element)) return element
  return [element.props.children].flat(Infinity).map(child => findElement(child, predicate)).find(Boolean)
}

// Run the real page, flow hook, state restoration and preview event handlers.
// Only the React scheduler and IO boundaries are replaced; no Canvas or API is needed.
function previewHost(view = {}) {
  const slots = []
  let cursor = 0, dirty = false, pending = [], tree
  const workspace = createWorkspace({ userId: 'preview-comparison-test', view_state: {
    creation_step: 'adjust', tool_tab: 'versions', display_mode: 'slider', ...view,
  } })
  const originalParams = structuredClone(workspace.params)
  let edits = 0
  const editor = { workspace, ready: true, histories: { past: [], future: [] },
    commit(patch) { if (patch) edits++ }, setMeta(meta) { Object.assign(workspace, meta) },
    restoreVersion(value) { workspace.params = structuredClone(value.params); dirty = true; return workspace },
    listProjects: async () => [], deletedProjectIds: async () => [] }
  const changed = (prior, next) => !prior || next.some((value, index) => !Object.is(value, prior[index]))
  const hooks = {
    ...React, useContext: () => ({ confirm: async () => true, prompt: async () => null }),
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
  new Function('require', 'module', 'exports', '__editor', '__api', 'window', 'requestAnimationFrame', bundle.outputFiles[0].text)(
    name => name === 'react' ? hooks : require(name), module, module.exports, editor,
    async (name, value) => name === 'createWorkspace' ? value : name === 'getAutoReport' ? null : [],
    { addEventListener() {}, removeEventListener() {} }, callback => callback(),
  )
  const render = () => {
    cursor = 0; pending = []; dirty = false
    tree = module.exports.default({ user: workspace.user_id })
    for (const effect of pending) effect()
  }
  render()
  return {
    workspace, originalParams, get edits() { return edits }, get tree() { return tree },
    find: predicate => findElement(tree, predicate),
    async settle() {
      for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); if (dirty) render() }
    },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

const versionPanel = host => host.find(element => element.type?.name === 'VersionPanel')
const comparisonPreview = host => host.find(element => element.type?.name === 'ComparisonPreview')
const version = (id, contrast) => ({ id, name: `版本 ${id}`, params: { ...defaultParams(), contrast } })
const previewButton = (host, label) => host.find(element => element.type === 'button' && element.props.children === label)

test('returning to manual adjustment after selecting A/B restores original/current preview', async () => {
  const host = previewHost()
  try {
    await host.settle()
    versionPanel(host).props.onCompare('a', version('a', .1))
    versionPanel(host).props.onCompare('b', version('b', .3))
    await host.settle()
    assert.ok(comparisonPreview(host), 'two saved versions enter A/B preview')
    const tabs = host.find(element => typeof element.props.onValueChange === 'function')
    tabs.props.onValueChange('manual')
    await host.settle()
    assert.equal(comparisonPreview(host), undefined, 'manual adjustment must show original and the current LUT rather than fixed version snapshots')
    assert.deepEqual(host.workspace.params, host.originalParams)
  } finally { host.unmount() }
})

test('preview target switch preserves A/B snapshots, display layout and formal editing state', async () => {
  const host = previewHost({ display_mode: 'split' })
  try {
    await host.settle()
    const a = version('a', .1), b = version('b', .3)
    versionPanel(host).props.onCompare('a', a)
    versionPanel(host).props.onCompare('b', b)
    await host.settle()
    a.params.contrast = .8
    const edits = host.edits
    previewButton(host, '原图 / 当前效果').props.onClick()
    await host.settle()
    assert.equal(comparisonPreview(host), undefined)
    assert.equal(host.workspace.view_state.comparison_mode, 'current')
    assert.equal(host.workspace.view_state.comparison.a.params.contrast, .1)
    assert.equal(host.workspace.view_state.display_mode, 'split')
    assert.equal(host.edits, edits, 'switching back is a view preference, not an edit')
    assert.deepEqual(host.workspace.params, host.originalParams)
    previewButton(host, '版本 A / B').props.onClick()
    await host.settle()
    assert.equal(comparisonPreview(host).props.a.params.contrast, .1)
    assert.equal(comparisonPreview(host).props.b.params.contrast, .3)
    assert.equal(host.workspace.view_state.comparison_mode, 'versions')
    assert.ok(host.find(element => element.type === 'label' && element.props.className === 'mode-select').props.hidden,
      'current-effect layout selector must not suggest it controls the fixed A/B preview')
  } finally { host.unmount() }
})

test('incomplete and empty A/B selection can always return to original/current preview', async () => {
  const host = previewHost()
  try {
    await host.settle()
    previewButton(host, '版本 A / B').props.onClick()
    await host.settle()
    assert.ok(comparisonPreview(host))
    assert.equal(comparisonPreview(host).props.a, undefined)
    versionPanel(host).props.onCloseCompare()
    await host.settle()
    assert.equal(comparisonPreview(host), undefined)
    versionPanel(host).props.onCompare('a', version('a', .2))
    await host.settle()
    assert.ok(comparisonPreview(host).props.a)
    assert.equal(comparisonPreview(host).props.b, undefined)
    previewButton(host, '原图 / 当前效果').props.onClick()
    await host.settle()
    assert.equal(comparisonPreview(host), undefined)
    assert.equal(versionPanel(host).props.comparison.a.params.contrast, .2)
  } finally { host.unmount() }
})

test('legacy saved comparisons remain available while explicit current-mode survives refresh', async () => {
  const comparison = { a: version('a', .1), b: version('b', .3) }
  const legacy = previewHost({ comparison })
  const current = previewHost({ comparison, comparison_mode: 'current' })
  try {
    await legacy.settle(); await current.settle()
    assert.ok(comparisonPreview(legacy), 'legacy comparisons retain their previous preview')
    assert.equal(comparisonPreview(current), undefined, 'saved current target must override retained A/B snapshots')
    assert.deepEqual(versionPanel(current).props.comparison, comparison)
    versionPanel(legacy).props.onCloseCompare()
    await legacy.settle()
    const reloaded = previewHost(structuredClone(legacy.workspace.view_state))
    try {
      await reloaded.settle()
      assert.equal(comparisonPreview(reloaded), undefined)
      previewButton(reloaded, '版本 A / B').props.onClick()
      await reloaded.settle()
      assert.equal(comparisonPreview(reloaded).props.b.params.contrast, .3)
    } finally { reloaded.unmount() }
  } finally { legacy.unmount(); current.unmount() }
})

test('restoring a version shows the restored draft rather than leaving unrelated A/B snapshots visible', async () => {
  const host = previewHost({ comparison: { a: version('a', .1), b: version('b', .3) } })
  try {
    await host.settle()
    assert.ok(comparisonPreview(host))
    await versionPanel(host).props.onRestore(version('restored', .5))
    await host.settle()
    assert.equal(comparisonPreview(host), undefined)
    assert.equal(host.workspace.params.contrast, .5)
    assert.equal(versionPanel(host).props.comparison.b.params.contrast, .3)
  } finally { host.unmount() }
})

test('parameter presentation is shared with the photo viewer and does not change grading state', async () => {
  const host = previewHost({ tool_tab: 'manual', comparison_mode: 'current' })
  try {
    await host.settle()
    const panel = () => host.find(element => element.type?.name === 'ParameterPanel')
    assert.equal(panel().props.allParameters, false)
    const edits = host.edits
    panel().props.onPresentationChange(true)
    await host.settle()
    assert.equal(host.workspace.view_state.all_parameters, true)
    previewButton(host, '放大查看').props.onClick()
    await host.settle()
    const viewer = () => host.find(element => element.props.adjustmentPanel)
    assert.equal(viewer().props.adjustmentPanel.props.allParameters, true)
    viewer().props.adjustmentPanel.props.onPresentationChange(false)
    await host.settle()
    assert.equal(panel().props.allParameters, false)
    assert.equal(host.edits, edits)
    assert.deepEqual(host.workspace.params, host.originalParams)
  } finally { host.unmount() }
})
