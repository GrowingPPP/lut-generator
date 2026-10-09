import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultParams, generateLUT, paramsToCube } from '../src/lib/lutEngine.js'

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
