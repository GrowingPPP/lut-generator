import { PARAM_LABELS } from './autoGrade.js'
import { defaultParams, normalizeParams } from './lutEngine.js'
import { inputContract } from './styleRecipe.js'
import { equalValue, clone } from './styleRecipe.js'

// 顺序与参数面板一致；技术输入单列，旧版本也补齐当前全部字段。
export const COMPARISON_GROUPS = Object.freeze([
  { id: 'technical', label: '输入', fields: ['base_photo_style', 'tone_map'] },
  { id: 'basic', label: '单张校正', fields: ['temp', 'tint', 'exposure'] },
  { id: 'look', label: '风格', fields: ['look_strength'] },
  {
    id: 'tone', label: '影调',
    fields: ['contrast', 'contrast_pivot', 'highlights', 'shadows', 'whites', 'blacks', 'curve', 'curve_points'],
  },
  { id: 'color', label: '色彩', fields: ['saturation', 'vibrance', 'hue'] },
  {
    id: 'selective', label: '局部色彩',
    fields: ['selective_hue_center', 'selective_hue_width', 'selective_hue_shift', 'selective_saturation'],
  },
  {
    id: 'split', label: '分离色调',
    fields: ['split_shadow_hue', 'split_shadow_sat', 'split_highlight_hue', 'split_highlight_sat',
      'split_mid_hue', 'split_mid_sat', 'split_balance'],
  },
  { id: 'rgb', label: '分通道(RGB)', fields: ['lift', 'gamma', 'gain'] },
  { id: 'external', label: '外部 LUT', fields: ['external_lut_id', 'external_lut_strength', 'external_lut_mode'] },
].map((group) => Object.freeze({ ...group, fields: Object.freeze(group.fields) })))

const DIFFERENCE_TOLERANCE = 1e-9
const CHANNEL_LABELS = ['红（R）', '绿（G）', '蓝（B）']

function formatNumber(value) {
  if (value === 0 || Object.is(value, -0)) return '0'
  if (!Number.isFinite(value)) return String(value)
  // 常见值最多显示 8 位小数；更小的非零值使用指数，保留可见差异。
  if (Math.abs(value) < 1e-8 || Math.abs(value) >= 1e8) {
    const [mantissa, exponent] = value.toExponential(7).split('e')
    return `${mantissa.replace(/\.?0+$/, '')}e${Number(exponent)}`
  }
  return value.toFixed(8).replace(/\.?0+$/, '')
}

function formatValue(value, unit, signed = false) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).map(([channel, points]) => `${channel === 'master' ? '主曲线' : channel.toUpperCase()} ${points.map(point => point.map(formatNumber).join('→')).join(' / ')}`).join('；')
  const text = (number) => `${signed && number > 0 ? '+' : ''}${formatNumber(number)}${unit}`
  if (Array.isArray(value)) {
    return value.map((number, index) => `${CHANNEL_LABELS[index]} ${text(number)}`).join(' / ')
  }
  return typeof value === 'number' ? text(value) : String(value)
}

function compareField(field, before, after) {
  const [label, unit] = PARAM_LABELS[field]
  let delta = null
  let changed
  if (Array.isArray(before)) {
    delta = after.map((value, index) => value - before[index])
    changed = delta.some((value) => Math.abs(value) > DIFFERENCE_TOLERANCE)
  } else if (typeof before === 'number') {
    delta = after - before
    changed = Math.abs(delta) > DIFFERENCE_TOLERANCE
  } else {
    changed = !equalValue(before, after)
  }
  return {
    field, label, unit,
    before: clone(before),
    after: clone(after),
    delta, changed,
    beforeText: formatValue(before, unit),
    afterText: formatValue(after, unit),
    deltaText: delta === null ? '已更改' : formatValue(delta, unit, true),
  }
}

export function compareVersionParams(aParams = defaultParams(), bParams = defaultParams()) {
  const before = normalizeParams(aParams)
  const after = normalizeParams(bParams)
  const groups = []
  let changedCount = 0
  for (const group of COMPARISON_GROUPS) {
    const rows = group.fields
      .map((field) => compareField(field, before[field], after[field]))
      .filter((row) => row.changed)
    if (!rows.length) continue
    groups.push({ id: group.id, label: group.label, rows })
    changedCount += rows.length
  }
  return { groups, changedCount, identical: changedCount === 0 }
}

export function compatibleVersionInputs(aParams, bParams) {
  const a = inputContract(normalizeParams(aParams))
  const b = inputContract(normalizeParams(bParams))
  return a.base_photo_style === b.base_photo_style && a.output_encoding === b.output_encoding
}
