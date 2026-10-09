import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultParams, generateLUT, normalizeParams, paramsToCube } from '../src/lib/lutEngine.js'

function sample(params, r, g, b, size = 17) {
  const { data } = generateLUT({ ...defaultParams(), ...params }, size)
  const idx = (b * size * size + g * size + r) * 4
  return Array.from(data.slice(idx, idx + 3))
}

test('白部和黑部极值保持灰阶顺序', () => {
  for (const params of [{ whites: -1 }, { whites: 1 }, { blacks: -1 }, { blacks: 1 }, { contrast: -1 }]) {
    const gray = Array.from({ length: 17 }, (_, i) => sample(params, i, i, i)[0])
    assert.ok(gray.every((v, i) => i === 0 || v >= gray[i - 1] - 1e-7), JSON.stringify(params))
    assert.ok(gray[16] - gray[0] > 0.15, JSON.stringify(params))
  }
})

test('零风格强度保留 V-Log 技术转换与曝光', () => {
  const technical = { base_photo_style: 'VLOG', tone_map: 0.7, exposure: 0.3 }
  const baseline = sample(technical, 8, 8, 8)
  const zeroLook = sample({ ...technical, contrast: 0.5, split_mid_sat: 0.5, look_strength: 0 }, 8, 8, 8)
  assert.deepEqual(zeroLook, baseline)
  assert.notDeepEqual(baseline, [0.5, 0.5, 0.5])
})

test('后期版标题写明输入输出信号', () => {
  const cube = paramsToCube({ ...defaultParams(), base_photo_style: 'VLOG' },
    { title: '测试', mode: 'software', size: 3 })
  assert.match(cube, /^TITLE "测试 \[VLOG\/V-Gamut -> Rec709\]"/)
  assert.doesNotMatch(cube, /#LUMIXPHOTOSTYLE/)
})

test('旧版会话参数补全后预览 LUT 与导出保持有效', () => {
  // 当前旧版 API 实际只返回这些字段；新增的风格强度、对比中心等字段会缺席。
  const legacy = {
    base_photo_style: 'STD', temp: -100, tint: 0, exposure: 0,
    contrast: 0.15, saturation: -0.25, hue: 0, vibrance: -0.05, tone_map: 1,
    highlights: -0.15, shadows: -0.1, whites: 0, blacks: 0, curve: 0.15,
    split_shadow_hue: 200, split_shadow_sat: 0.15,
    split_highlight_hue: 40, split_highlight_sat: 0.08, split_balance: 0.5,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
  }
  const normalized = normalizeParams(legacy)
  assert.equal(normalized.look_strength, 1)
  assert.equal(normalized.contrast_pivot, 0.462)
  assert.equal(normalized.split_mid_sat, 0)
  const { data } = generateLUT(legacy, 17)
  assert.ok(data.every(Number.isFinite))
  const middle = (8 * 17 * 17 + 8 * 17 + 8) * 4
  assert.ok(data[middle] > 0.1 && data[middle] < 0.9)
  const cube = paramsToCube(legacy, { title: '旧版会话', size: 3 })
  assert.doesNotMatch(cube, /NaN|Infinity/)
})

test('无效的可选数值回退到默认值', () => {
  const normalized = normalizeParams({ look_strength: null, contrast_pivot: NaN, gain: [1.1, Infinity] })
  assert.equal(normalized.look_strength, 1)
  assert.equal(normalized.contrast_pivot, 0.462)
  assert.deepEqual(normalized.gain, [1.1, 1, 1])
})
