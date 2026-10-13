import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import * as React from 'react'
import { defaultParams } from '../src/lib/lutEngine.js'
import { PARAM_GROUPS } from '../src/lib/parameterControls.js'
import { commitEdit, createWorkspaceState, undoEdit } from '../src/lib/workspace.js'

const require = createRequire(import.meta.url)
const filenames = ['ParameterControls.jsx', 'PhotoAdjustments.jsx']
const bundled = new Map(await Promise.all(filenames.map(async filename => {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/components/${filename}`, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    loader: { '.css': 'empty' }, plugins: [{ name: 'controlled-confirmation', setup(builder) {
      builder.onResolve({ filter: /ui\/Dialog\.jsx$/ }, () => ({ path: 'dialog', namespace: 'controlled-confirmation' }))
      builder.onLoad({ filter: /.*/, namespace: 'controlled-confirmation' }, () => ({
        contents: 'export function useDialogs() { return { confirm: __parameterDialogConfirm } }',
      }))
    } }] })
  return [filename, result.outputFiles[0].text]
})))

// The components' event handlers run with persistent hooks so pending confirmations
// can be tested across prop changes without adding a browser test dependency.
function componentHarness(filename, initialProps, confirm = async () => false) {
  const slots = [], cleanups = []
  let cursor = 0, props = initialProps
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect, dependencies) {
      const index = cursor++
      if (!slots[index] || !dependencies || dependencies.some((value, offset) => value !== slots[index][offset])) {
        cleanups[index]?.()
        cleanups[index] = effect()
        slots[index] = dependencies || []
      }
    },
    useImperativeHandle(ref, create) { if (ref) ref.current = create() },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__parameterDialogConfirm', bundled.get(filename))(
    name => name === 'react' ? hooks : require(name), module, module.exports, confirm)
  const Component = module.exports.default
  return {
    render(next = {}) {
      cursor = 0
      props = { ...props, ...next }
      return Component.render ? Component.render(props, null) : Component(props)
    },
    unmount() { cleanups.forEach(cleanup => cleanup?.()) },
  }
}

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, predicate))
  if (!tree?.props) return []
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props.children, predicate)]
}
const management = tree => elements(tree, element => element.props.label === '参数管理')[0]
const action = (tree, id) => management(tree).props.items.find(item => item.id === id)
const protection = (tree, label) => elements(tree, element => element.type.name === 'ProtectionButton' && element.props.label === label)[0]
const actualButton = element => elements(element.type(element.props), candidate => candidate.type === 'button')[0]
function props(overrides = {}) {
  return { params: defaultParams(), lockedFields: [], contextKey: 'project-one',
    onSetLocks() {}, onReset() {}, onToggleLock() {}, onUpdateParam() {}, onUpdateChannel() {}, ...overrides }
}
function deferredConfirmation() {
  let resolve
  const requests = []
  return { requests, confirm: options => { requests.push(options); return new Promise(settle => { resolve = settle }) },
    settle: result => resolve(result) }
}

test('management protects every parameter, including technical input, curves and external LUT fields', () => {
  const selected = []
  const harness = componentHarness('ParameterControls.jsx', props({ onSetLocks: fields => selected.push(fields) }))
  const tree = harness.render()
  action(tree, 'protect-all').onSelect()
  assert.deepEqual(selected[0], Object.keys(defaultParams()))
  for (const field of ['base_photo_style', 'tone_map', 'curve_points', 'external_lut_id', 'external_lut_strength', 'external_lut_mode']) {
    assert.ok(selected[0].includes(field), field)
  }
  const protectedTree = harness.render({ lockedFields: selected[0] })
  assert.equal(action(protectedTree, 'protect-all').disabled, true)
  action(protectedTree, 'unlock-all').onSelect()
  assert.deepEqual(selected[1], [])
  assert.equal(elements(tree, element => element.props.className === 'all-parameter-actions').length, 0)
  harness.unmount()
})

test('single and group protection states disable manual input and distinguish partial protection', () => {
  const toggled = []
  const fields = PARAM_GROUPS.find(group => group.id === 'basic').sliders.map(slider => slider.key)
  const harness = componentHarness('ParameterControls.jsx', props({ lockedFields: ['exposure'], onToggleLock: value => toggled.push(value) }))
  const tree = harness.render()
  const group = protection(tree, '单张校正参数组')
  assert.equal(actualButton(group).props['aria-pressed'], 'mixed')
  group.props.onClick()
  assert.deepEqual(toggled[0], fields)
  assert.equal(actualButton(protection(tree, '曝光')).props['aria-pressed'], true)
  const manualInputs = elements(tree, element => element.props['aria-label'] === '曝光' || element.props['aria-label'] === '曝光 数值')
  assert.ok(manualInputs.length >= 2)
  assert.ok(manualInputs.every(element => element.props.disabled))
  const allTree = harness.render({ lockedFields: fields })
  assert.equal(actualButton(protection(allTree, '单张校正参数组')).props['aria-pressed'], true)
  const noTree = harness.render({ lockedFields: [] })
  assert.equal(actualButton(protection(noTree, '单张校正参数组')).props['aria-pressed'], false)
  harness.unmount()
})

test('cancel leaves the edit intact; confirmed reset preserves locks and input and remains undoable', async () => {
  const confirmation = deferredConfirmation()
  let state = createWorkspaceState({ params: { exposure: .8, contrast: .2, base_photo_style: 'NAT', tone_map: .5,
    curve_points: { ...defaultParams().curve_points, master: [[0, 0], [.5, .65], [1, 1]] },
    external_lut_id: '00000000-0000-4000-8000-000000000001', external_lut_strength: .7 } })
  state = commitEdit(state, null, { source: 'lock', context: { locked_fields: ['exposure'] } })
  const before = structuredClone(state)
  const harness = componentHarness('ParameterControls.jsx', props({ params: state.workspace.params,
    lockedFields: state.workspace.locked_fields, onReset: fields => { state = commitEdit(state, null, { source: 'reset', resetFields: fields }) } }), confirmation.confirm)
  const cancel = action(harness.render(), 'reset-unprotected').onSelect()
  assert.match(confirmation.requests[0].description, /自由曲线和外部 LUT/)
  assert.match(confirmation.requests[0].description, /输入基准与显示映射/)
  confirmation.settle(false)
  await cancel
  assert.deepEqual(state, before)
  const reset = action(harness.render(), 'reset-unprotected').onSelect()
  confirmation.settle(true)
  await reset
  assert.equal(state.workspace.params.exposure, .8)
  assert.equal(state.workspace.params.base_photo_style, 'NAT')
  assert.equal(state.workspace.params.tone_map, .5)
  assert.equal(state.workspace.params.contrast, defaultParams().contrast)
  assert.deepEqual(state.workspace.params.curve_points, defaultParams().curve_points)
  assert.equal(state.workspace.params.external_lut_id, null)
  assert.deepEqual(state.workspace.locked_fields, ['exposure'])
  assert.deepEqual(undoEdit(state).workspace.params, before.workspace.params)
  harness.unmount()
})

test('late confirmations cannot reset changed parameters, locks, projects, a busy cycle or an unmounted panel', async () => {
  for (const reason of ['params', 'locks', 'project', 'busy', 'unmount']) {
    const confirmation = deferredConfirmation(), resets = []
    const harness = componentHarness('ParameterControls.jsx', props({ onReset: fields => resets.push(fields) }), confirmation.confirm)
    const reset = action(harness.render(), 'reset-unprotected').onSelect()
    if (reason === 'params') harness.render({ params: { ...defaultParams(), exposure: .2 } })
    if (reason === 'locks') harness.render({ lockedFields: ['exposure'] })
    if (reason === 'project') harness.render({ contextKey: 'project-two' })
    if (reason === 'busy') { harness.render({ disabled: true }); harness.render({ disabled: false }) }
    if (reason === 'unmount') harness.unmount()
    confirmation.settle(true)
    await reset
    assert.equal(resets.length, 0, reason)
    harness.unmount()
  }
})

test('stale menu callbacks cannot protect or reset parameters after becoming busy', async () => {
  const confirmation = deferredConfirmation(), mutations = []
  const harness = componentHarness('ParameterControls.jsx', props({ onSetLocks: fields => mutations.push(fields), onReset: fields => mutations.push(fields) }), confirmation.confirm)
  const tree = harness.render()
  harness.render({ disabled: true })
  action(tree, 'protect-all').onSelect()
  action(tree, 'unlock-all').onSelect()
  await action(tree, 'reset-unprotected').onSelect()
  assert.deepEqual(mutations, [])
  assert.deepEqual(confirmation.requests, [])
  harness.unmount()
})

test('viewer completes partial external LUT protection and removes a fully protected group', () => {
  const calls = []
  const externalFields = ['external_lut_id', 'external_lut_strength', 'external_lut_mode']
  const workspace = { id: 'viewer-project', params: { ...defaultParams(), external_lut_id: '00000000-0000-4000-8000-000000000001' },
    locked_fields: ['exposure', 'external_lut_strength'] }
  const editor = { workspace, saveStatus: 'saved', setLocks: fields => calls.push(fields), commit() {}, reset() {} }
  const harness = componentHarness('PhotoAdjustments.jsx', { editor, disabled: false, onToggleLock: fields => calls.push(fields) })
  const tree = harness.render()
  const external = protection(tree, '外部 LUT')
  assert.equal(actualButton(external).props['aria-pressed'], 'mixed')
  assert.equal(actualButton(external).props['aria-label'], '保护外部 LUT')
  external.props.onClick()
  assert.deepEqual(calls[0], externalFields)
  const intensity = elements(tree, element => element.props['aria-label'] === '外部 LUT 叠加强度')[0]
  assert.equal(intensity.props.disabled, true)
  editor.workspace = { ...workspace, locked_fields: ['exposure', ...externalFields] }
  protection(harness.render({ editor }), '外部 LUT').props.onClick()
  assert.deepEqual(calls[1], ['exposure'])
  harness.unmount()
})
