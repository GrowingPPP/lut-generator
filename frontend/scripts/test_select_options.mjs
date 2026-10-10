import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement as h, Fragment } from 'react'
import {
  decodeSelectValue, encodeSelectValue, initialSelectValue, selectedSelectOption,
  selectOptionsFromChildren,
} from '../src/lib/selectOptions.js'

test('选项兼容数组、条件、碎片、数字值与文字推导', () => {
  const options = selectOptionsFromChildren([
    h('option', { value: '' }, '请选择'),
    false,
    h(Fragment, null, [h('option', { key: 'zero', value: 0 }, '零'), h('option', { key: 'display' }, '  Rec709\n 显示  ')]),
    h('option', { value: 'cube', disabled: true, description: '需要匹配输入', label: '外部 LUT' }, '库'),
  ])
  assert.deepEqual(options, [
    { value: '', label: '请选择', description: undefined, disabled: false, selected: false },
    { value: '0', label: '零', description: undefined, disabled: false, selected: false },
    { value: 'Rec709 显示', label: 'Rec709 显示', description: undefined, disabled: false, selected: false },
    { value: 'cube', label: '外部 LUT', description: '需要匹配输入', disabled: true, selected: false },
  ])
})

test('空值与任意文字编码可逆，不与菜单内部标记混淆', () => {
  const values = ['', '0', '100', '中文 🎨', 'chroma-option:', '%', 'a:b /c?d=e']
  const encoded = values.map(encodeSelectValue)
  assert.ok(encoded.every(value => value !== ''))
  assert.equal(new Set(encoded).size, values.length)
  encoded.forEach((value, index) => assert.equal(decodeSelectValue(value), values[index]))
  assert.equal(decodeSelectValue(''), undefined)
  assert.equal(decodeSelectValue('not-an-option'), undefined)
  assert.equal(decodeSelectValue('chroma-option:%'), undefined)
})

test('保留空值选择，缺少当前选项时回退首个可用项', () => {
  const options = selectOptionsFromChildren([
    h('option', { value: 'disabled', disabled: true }, '不可用'),
    h('option', { value: '' }, '不使用'),
    h('option', { value: 100 }, '100%'),
  ])
  assert.equal(initialSelectValue(options), '')
  assert.equal(initialSelectValue(options, 100), '100')
  assert.equal(selectedSelectOption(options, '').value, '')
  assert.equal(selectedSelectOption(options, 100).label, '100%')
  assert.equal(selectedSelectOption(options, 'missing').value, '')
  assert.equal(selectedSelectOption([], '')?.value, undefined)
})

test('动态选项回显最新名称，显式选择与禁用组保留原生语义', () => {
  const before = selectOptionsFromChildren(h('option', { value: 'id' }, '当前引用（载入中）'))
  const after = selectOptionsFromChildren(h('option', { value: 'id' }, '清透风格'))
  assert.equal(selectedSelectOption(before, 'id').label, '当前引用（载入中）')
  assert.equal(selectedSelectOption(after, 'id').label, '清透风格')
  const options = selectOptionsFromChildren([
    h('option', { value: 'first' }, '首项'),
    h('option', { value: 'selected', selected: true }, '已选择'),
    h('optgroup', { disabled: true }, h('option', { value: 'group' }, '组中选项')),
  ])
  assert.equal(initialSelectValue(options), 'selected')
  assert.equal(options[2].disabled, true)
  assert.equal(selectedSelectOption(options, 'group').value, 'group')
})
