import assert from 'node:assert/strict'
import test from 'node:test'
import { PARAM_LABELS } from '../src/lib/autoGrade.js'
import { defaultParams } from '../src/lib/lutEngine.js'
import { COMPARISON_GROUPS, compareVersionParams, compatibleVersionInputs } from '../src/lib/versionComparison.js'

const rowsOf = (result) => result.groups.flatMap((group) => group.rows)

test('groups cover all 30 parameters once, in parameter-panel order', () => {
  const fields = COMPARISON_GROUPS.flatMap((group) => group.fields)
  assert.equal(fields.length, 30)
  assert.equal(new Set(fields).size, 30)
  assert.deepEqual([...fields].sort(), Object.keys(defaultParams()).sort())
  assert.deepEqual(COMPARISON_GROUPS.map((group) => group.id), [
    'technical', 'basic', 'look', 'tone', 'color', 'selective', 'split', 'rgb',
  ])
  assert.deepEqual(COMPARISON_GROUPS.map((group) => group.label), [
    '输入', '单张校正', '风格', '影调', '色彩', '局部色彩', '分离色调', '分通道(RGB)',
  ])
  assert.deepEqual(fields, [
    'base_photo_style', 'tone_map', 'temp', 'tint', 'exposure', 'look_strength',
    'contrast', 'contrast_pivot', 'highlights', 'shadows', 'whites', 'blacks', 'curve',
    'saturation', 'vibrance', 'hue', 'selective_hue_center', 'selective_hue_width',
    'selective_hue_shift', 'selective_saturation', 'split_shadow_hue', 'split_shadow_sat',
    'split_highlight_hue', 'split_highlight_sat', 'split_mid_hue', 'split_mid_sat',
    'split_balance', 'lift', 'gamma', 'gain',
  ])
})

test('every parameter can independently produce a labeled difference', () => {
  const before = defaultParams()
  for (const group of COMPARISON_GROUPS) {
    for (const field of group.fields) {
      const value = before[field]
      const after = {
        ...before,
        [field]: Array.isArray(value) ? value.map((item, index) => item + (index === 1 ? 0.01 : 0))
          : typeof value === 'number' ? value + 0.01 : 'NAT',
      }
      const result = compareVersionParams(before, after)
      assert.equal(result.changedCount, 1, field)
      assert.equal(result.identical, false, field)
      assert.equal(result.groups.length, 1, field)
      assert.equal(result.groups[0].id, group.id, field)
      const [row] = rowsOf(result)
      assert.equal(row.field, field)
      assert.equal(row.label, PARAM_LABELS[field][0])
      assert.equal(row.unit, PARAM_LABELS[field][1])
      assert.equal(row.changed, true)
    }
  }
})

test('returns ordered changed fields with exposure, tone-map and channel deltas', () => {
  const before = defaultParams()
  const after = {
    ...before,
    tone_map: 0.5,
    exposure: 0.25,
    hue: -2.5,
    lift: [0.01, -0.02, 0],
    gamma: [1.1, 1, 0.9],
  }
  const result = compareVersionParams(before, after)
  assert.equal(result.changedCount, 5)
  assert.deepEqual(result.groups.map((group) => group.id), ['technical', 'basic', 'color', 'rgb'])
  assert.deepEqual(rowsOf(result).map((row) => row.field), ['tone_map', 'exposure', 'hue', 'lift', 'gamma'])
  const [mapping, exposure, hue, lift, gamma] = rowsOf(result)
  assert.equal(mapping.delta, -0.5)
  assert.equal(mapping.deltaText, '-0.5')
  assert.equal(exposure.beforeText, '0 EV')
  assert.equal(exposure.afterText, '0.25 EV')
  assert.equal(exposure.deltaText, '+0.25 EV')
  assert.equal(hue.afterText, '-2.5°')
  assert.deepEqual(lift.delta, [0.01, -0.02, 0])
  assert.equal(lift.beforeText, '红（R） 0 / 绿（G） 0 / 蓝（B） 0')
  assert.equal(lift.afterText, '红（R） 0.01 / 绿（G） -0.02 / 蓝（B） 0')
  assert.equal(lift.deltaText, '红（R） +0.01 / 绿（G） -0.02 / 蓝（B） 0')
  assert.equal(gamma.deltaText, '红（R） +0.1 / 绿（G） 0 / 蓝（B） -0.1')
})

test('equal and legacy missing values explicitly return identical', () => {
  assert.deepEqual(compareVersionParams(defaultParams(), defaultParams()), {
    groups: [], changedCount: 0, identical: true,
  })
  assert.deepEqual(compareVersionParams({}, undefined), {
    groups: [], changedCount: 0, identical: true,
  })
  assert.deepEqual(compareVersionParams(null, null), {
    groups: [], changedCount: 0, identical: true,
  })
  assert.deepEqual(compareVersionParams({ gamma: [1], exposure: 0 }, defaultParams()), {
    groups: [], changedCount: 0, identical: true,
  })
})

test('scalar and RGB tolerance agree, and visible tiny changes never round to zero', () => {
  const before = defaultParams()
  assert.equal(compareVersionParams(before, {
    ...before, exposure: 1e-9, lift: [1e-9, -1e-9, 0],
  }).identical, true)
  const result = compareVersionParams(before, {
    ...before, exposure: 1.2e-9, temp: 0.00000012, lift: [0, -1.2e-9, 1e-9],
  })
  assert.equal(result.changedCount, 3)
  const [temp, exposure, lift] = rowsOf(result)
  assert.equal(temp.deltaText, '+0.00000012')
  assert.equal(exposure.afterText, '1.2e-9 EV')
  assert.equal(exposure.deltaText, '+1.2e-9 EV')
  assert.equal(lift.deltaText, '红（R） 0 / 绿（G） -1.2e-9 / 蓝（B） +1e-9')
})

test('frozen input objects and arrays are untouched, returned arrays are independent', () => {
  const before = Object.freeze({ ...defaultParams(), lift: Object.freeze([0, 0, 0]) })
  const after = Object.freeze({ ...defaultParams(), lift: Object.freeze([0.01, 0, 0]) })
  const result = compareVersionParams(before, after)
  const [row] = rowsOf(result)
  assert.deepEqual(before.lift, [0, 0, 0])
  assert.deepEqual(after.lift, [0.01, 0, 0])
  assert.notEqual(row.before, before.lift)
  assert.notEqual(row.after, after.lift)
  row.before[0] = 9
  row.after[0] = 9
  row.delta[0] = 9
  assert.deepEqual(before.lift, [0, 0, 0])
  assert.deepEqual(after.lift, [0.01, 0, 0])
})

test('input compatibility uses base and output encoding while permitting tone-map changes', () => {
  assert.equal(compatibleVersionInputs({}, defaultParams()), true)
  assert.equal(compatibleVersionInputs(
    { base_photo_style: 'VLOG', tone_map: 1 },
    { base_photo_style: 'VLOG', tone_map: 0.25 },
  ), true)
  assert.equal(compatibleVersionInputs({ base_photo_style: 'STD' }, { base_photo_style: 'NAT' }), false)
  assert.equal(compatibleVersionInputs({ base_photo_style: 'STD' }, { base_photo_style: 'VLOG' }), false)
  // 编码由参数输入基准推导，参数模型之外的字段不影响判定。
  assert.equal(compatibleVersionInputs(
    { base_photo_style: 'VLOG', output_encoding: 'sRGB' },
    { base_photo_style: 'VLOG', output_encoding: 'Rec709' },
  ), true)
})

test('incompatible inputs still report the complete parameter difference', () => {
  const before = defaultParams()
  const after = { ...before, base_photo_style: 'VLOG', tone_map: 0.3, exposure: 0.2 }
  assert.equal(compatibleVersionInputs(before, after), false)
  const result = compareVersionParams(before, after)
  assert.equal(result.changedCount, 3)
  const [base, mapping, exposure] = rowsOf(result)
  assert.equal(base.field, 'base_photo_style')
  assert.equal(base.before, 'STD')
  assert.equal(base.after, 'VLOG')
  assert.equal(base.delta, null)
  assert.equal(base.deltaText, '已更改')
  assert.equal(mapping.field, 'tone_map')
  assert.equal(exposure.field, 'exposure')
})
