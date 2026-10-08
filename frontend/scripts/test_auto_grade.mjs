// 自动修图展示层纯函数测试。零依赖:用 Node 内置 node:test,与 check_parity.mjs 同一风格。
//
//   cd frontend && node --test scripts/
//
// 这些函数的价值在于「把技术字段翻成中文」—— 漏一个就会把原始键名甩给用户,
// 而这类问题在浏览器里一眼看不出来(界面不报错,只是文案变成 highlights 0)。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PARAM_LABELS,
  buildAutoGradePayload,
  diffParams,
  gradeHeadline,
  rejectionList,
  summarizeSteps,
} from '../src/lib/autoGrade.js'
import { defaultParams } from '../src/lib/lutEngine.js'

test('PARAM_LABELS 覆盖全部参数', () => {
  const params = Object.keys(defaultParams())
  const missing = params.filter((k) => !(k in PARAM_LABELS))
  assert.deepEqual(missing, [], `这些参数没有中文展示名: ${missing}`)
})

test('PARAM_LABELS 没有多余键', () => {
  const params = new Set(Object.keys(defaultParams()))
  const extra = Object.keys(PARAM_LABELS).filter((k) => !params.has(k))
  assert.deepEqual(extra, [], `这些展示名已无对应参数: ${extra}`)
})

test('buildAutoGradePayload 必带 base_params 与 use_vision', () => {
  const p = buildAutoGradePayload({ params: { temp: 300 }, useVision: true })
  assert.equal(p.base_params.temp, 300)
  assert.equal(p.use_vision, true)
})

test('空白风格不进载荷', () => {
  assert.equal(buildAutoGradePayload({ params: {}, style: '   ' }).style, undefined)
  assert.equal(buildAutoGradePayload({ params: {}, style: '' }).style, undefined)
  assert.equal(buildAutoGradePayload({ params: {}, style: ' 日系 ' }).style, '日系')
})

test('diffParams 只列出真正变化的字段', () => {
  const before = { temp: 300, contrast: 0, exposure: 0 }
  const after = { temp: 120, contrast: 0, exposure: 0 }
  const out = diffParams(before, after)
  assert.equal(out.length, 1)
  assert.equal(out[0].key, 'temp')
  assert.match(out[0].text, /色温/)
  assert.match(out[0].text, /-180/)
  assert.match(out[0].text, /偏冷/)     // 负值 = 降温
})

test('diffParams 正色温标注偏暖', () => {
  const out = diffParams({ temp: 0 }, { temp: 400 })
  assert.match(out[0].text, /\+400/)
  assert.match(out[0].text, /偏暖/)
})

test('diffParams 小数不取整成 0', () => {
  // 这些增量本来就在 0.01 量级,取整会把 0.06 显示成 0
  const out = diffParams({ contrast: 0 }, { contrast: 0.06 })
  assert.match(out[0].text, /\+0\.06/)
  assert.doesNotMatch(out[0].text, /\+0$/)
})

test('diffParams 处理三通道数组', () => {
  const out = diffParams({ lift: [0, 0, 0] }, { lift: [-0.03, 0.02, 0] })
  assert.equal(out.length, 1)
  assert.match(out[0].text, /暗部 RGB/)
  assert.match(out[0].text, /-0\.03\/\+0\.02\/\+0\.00/)
})

test('diffParams 数组无变化时不列出', () => {
  assert.deepEqual(diffParams({ lift: [0, 0, 0] }, { lift: [0, 0, 0] }), [])
})

test('diffParams 覆盖全部新增参数不报错', () => {
  const before = defaultParams()
  const after = {
    ...before, highlights: -0.3, shadows: 0.4, curve: 0.2,
    split_shadow_hue: 215, split_shadow_sat: 0.2,
    split_highlight_hue: 38, split_highlight_sat: 0.18,
  }
  const out = diffParams(before, after)
  const keys = out.map((o) => o.key).sort()
  assert.deepEqual(keys, ['curve', 'highlights', 'shadows', 'split_highlight_hue',
    'split_highlight_sat', 'split_shadow_hue', 'split_shadow_sat'])
  // 每一项都必须有中文名,不能露出原始键名
  for (const o of out) {
    assert.notEqual(o.label, o.key, `${o.key} 没有中文展示名`)
    assert.ok(o.text.length > 0)
  }
})

test('summarizeSteps 固定 4 步且顺序稳定', () => {
  const steps = [
    { stage: 'optimize', round: 1, diagnosis: '偏暗', applied: true, rejections: [] },
    { stage: 'optimize', round: 2, diagnosis: '再修', applied: true, rejections: [] },
  ]
  const out = summarizeSteps(steps, { hasStyle: true, hasVision: true })
  assert.equal(out.length, 4)
  assert.deepEqual(out.map((s) => s.key), ['measure', 'optimize', 'style', 'review'])
  assert.deepEqual(out.map((s) => s.title),
    ['测量照片', '修正影调与色彩', '风格化', '视觉复核'])
})

test('summarizeSteps 无风格时标记 skipped', () => {
  const out = summarizeSteps([], { hasStyle: false, hasVision: true })
  assert.equal(out[2].state, 'skipped')
  assert.match(out[2].detail, /未指定风格/)
  assert.equal(out[3].state, 'done')
})

test('summarizeSteps 关视觉复核时标记 skipped', () => {
  const out = summarizeSteps([], { hasStyle: true, hasVision: false })
  assert.equal(out[3].state, 'skipped')
  assert.match(out[3].detail, /已关闭视觉复核/)
})

test('summarizeSteps 统计被拦下的轮数', () => {
  const steps = [
    { stage: 'optimize', round: 1, diagnosis: 'a', applied: true, rejections: [] },
    { stage: 'optimize', round: 2, diagnosis: 'b', applied: false, rejections: ['太激进'] },
  ]
  const out = summarizeSteps(steps, { hasStyle: false, hasVision: false })
  assert.match(out[1].detail, /1 轮修正已应用/)
  assert.match(out[1].detail, /1 轮被安全规则拦下/)
})

test('rejectionList 汇总所有被拒原因', () => {
  const steps = [
    { rejections: ['a', 'b'] },
    { rejections: [] },
    { rejections: ['c'] },
    {},
  ]
  assert.deepEqual(rejectionList(steps), ['a', 'b', 'c'])
})

test('gradeHeadline 区分降级/无调整/已调整', () => {
  assert.match(gradeHeadline({ degraded: true, steps: [] }), /保守调整/)
  assert.match(gradeHeadline({ degraded: false, steps: [] }), /无需明显调整/)
  assert.match(gradeHeadline({ degraded: false, steps: [{ applied: true }] }), /1 步/)
  assert.equal(gradeHeadline(null), '')
})
