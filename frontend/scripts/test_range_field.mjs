import assert from 'node:assert/strict'
import test from 'node:test'
import { createRangeGesture, formatRangeNumber, parseRangeNumber } from '../src/lib/rangeField.js'
import { beginEdit, cancelEdit, commitEdit, createWorkspaceState, previewEdit, undoEdit } from '../src/lib/workspace.js'

test('数值编辑拒绝空值、非有限数、越界及不合法步长，接受合法精细值', () => {
  const bounds = { min: -3, max: 3, step: 0.05 }
  for (const value of ['', ' ', 'NaN', 'Infinity', '1e999', '0x10', '--1']) {
    assert.equal(parseRangeNumber(value, bounds).valid, false, value)
  }
  for (const value of [-3.05, 3.05]) assert.equal(parseRangeNumber(value, bounds).reason, 'range')
  assert.equal(parseRangeNumber('0.17', bounds).reason, 'step')
  assert.deepEqual(parseRangeNumber('-0.15', bounds), { valid: true, value: -0.15 })
  assert.deepEqual(parseRangeNumber('0.15000000000000002', bounds), { valid: true, value: 0.15 })
  assert.deepEqual(parseRangeNumber('1.005', { min: 0.5, max: 1.5, step: 0.005 }), { valid: true, value: 1.005 })
})

test('显示保留已有默认值和已有精度，不会因打开数字字段而量化参数', () => {
  const bounds = { min: 0.1, max: 0.9, step: 0.005 }
  assert.equal(formatRangeNumber(0.462, 0.005), '0.462')
  assert.deepEqual(parseRangeNumber('0.462', bounds, 0.462), { valid: true, value: 0.462 })
  assert.equal(parseRangeNumber('0.462', bounds, 0.5).reason, 'step')
  assert.equal(formatRangeNumber(0.12345678901, 0.01), '0.12345678901')
  assert.equal(formatRangeNumber(0.05, 0.05), '0.05')
  assert.equal(formatRangeNumber(100, 10), '100')
})

function editingHarness() {
  let state = createWorkspaceState()
  const calls = []
  const begin = () => { calls.push('begin'); state = beginEdit(state, { source: 'manual' }) }
  const commit = event => { calls.push(`commit:${event.target.value}`); state = commitEdit(state) }
  const callbacks = {
    onPointerDown: begin, onKeyDown: begin,
    onChange: event => { calls.push(`update:${event.target.value}`); state = previewEdit(state, { exposure: Number(event.target.value) }) },
    onPointerUp: commit, onKeyUp: commit, onBlur: commit,
    onPointerCancel: () => { calls.push('cancel'); state = cancelEdit(state) },
  }
  return { gesture: createRangeGesture(() => callbacks, 0), callbacks, calls, get state() { return state } }
}

test('整次滑块拖动先开始再更新，仅提交一次，撤销恢复完整起点', () => {
  const harness = editingHarness()
  harness.gesture.begin('pointer')
  for (const value of [0.05, 0.10, 0.15, 0.20]) harness.gesture.update(value)
  assert.equal(harness.state.past.length, 0)
  harness.gesture.finish('pointer')
  harness.gesture.finish('capture')
  harness.gesture.finish('blur')
  assert.equal(harness.calls[0], 'begin')
  assert.equal(harness.calls.filter(call => call.startsWith('commit')).length, 1)
  assert.equal(harness.calls.at(-1), 'commit:0.2')
  assert.equal(harness.state.past.length, 1)
  assert.equal(harness.state.past[0].source, 'manual')
  assert.equal(undoEdit(harness.state).workspace.params.exposure, 0)
})

test('方向键连续重复直到释放为一次历史，使用最新值和最新回调', () => {
  const harness = editingHarness()
  for (const value of [0.05, 0.10, 0.15]) {
    harness.gesture.begin('key', { key: 'ArrowRight' })
    harness.gesture.update(value)
  }
  let lastValue
  const commit = harness.callbacks.onKeyUp
  harness.callbacks.onKeyUp = event => { lastValue = event.target.value; commit(event) }
  harness.gesture.finish('key')
  assert.equal(lastValue, '0.15')
  assert.equal(harness.calls.filter(call => call === 'begin').length, 1)
  assert.equal(harness.state.past.length, 1)
})

test('失去捕获、禁用和卸载结束当前手势；取消遵守调用方回滚语义', () => {
  for (const reason of ['capture', 'disabled', 'unmount']) {
    const harness = editingHarness()
    harness.gesture.begin('pointer')
    harness.gesture.update(0.25)
    harness.gesture.finish(reason)
    assert.equal(harness.state.pending, null)
    assert.equal(harness.state.workspace.params.exposure, 0.25)
    assert.equal(harness.state.past.length, 1)
  }
  const cancelled = editingHarness()
  cancelled.gesture.begin('pointer')
  cancelled.gesture.update(0.25)
  cancelled.gesture.finish('cancel')
  cancelled.gesture.finish('capture')
  assert.equal(cancelled.state.pending, null)
  assert.equal(cancelled.state.workspace.params.exposure, 0)
  assert.equal(cancelled.state.past.length, 0)
})

test('没有预先指针或键盘事件的更新仍先开启事务再一次提交', () => {
  const harness = editingHarness()
  harness.gesture.update(0.5)
  assert.deepEqual(harness.calls, ['begin', 'update:0.5', 'commit:0.5'])
  assert.equal(harness.state.past.length, 1)
})
