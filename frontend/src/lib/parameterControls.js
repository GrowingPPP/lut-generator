import { defaultParams } from './lutEngine.js'

export const PARAM_GROUPS = [
  {
    id: 'basic', label: '单张校正', defaultOpen: true,
    sliders: [
      { key: 'temp', label: '冷暖偏移', min: -3000, max: 3000, step: 10, unit: '' },
      { key: 'tint', label: '绿/洋红', min: -500, max: 500, step: 5, unit: '' },
      { key: 'exposure', label: '曝光', min: -3, max: 3, step: 0.05, unit: ' EV' },
    ],
  },
  {
    id: 'look', label: '风格', defaultOpen: true,
    sliders: [
      { key: 'look_strength', label: '风格强度', min: 0, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'tone', label: '影调', defaultOpen: true,
    sliders: [
      { key: 'contrast', label: '对比度', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'contrast_pivot', label: '对比中心', min: 0.1, max: 0.9, step: 0.005, unit: '' },
      { key: 'highlights', label: '高光', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'shadows', label: '阴影', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'whites', label: '白部层次', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'blacks', label: '黑部层次', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'curve', label: 'S 曲线', min: -1, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'color', label: '色彩', defaultOpen: false,
    sliders: [
      { key: 'saturation', label: '饱和度', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'vibrance', label: '自然饱和', min: -1, max: 1, step: 0.01, unit: '' },
      { key: 'hue', label: '全局色相', min: -180, max: 180, step: 1, unit: '°' },
    ],
  },
  {
    id: 'selective', label: '局部色彩', defaultOpen: false,
    sliders: [
      { key: 'selective_hue_center', label: '目标色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'selective_hue_width', label: '色相范围', min: 1, max: 180, step: 1, unit: '°' },
      { key: 'selective_hue_shift', label: '目标色相偏移', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'selective_saturation', label: '目标色饱和', min: -1, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'split', label: '分离色调', defaultOpen: false,
    sliders: [
      { key: 'split_shadow_hue', label: '阴影色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_shadow_sat', label: '阴影强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_highlight_hue', label: '高光色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_highlight_sat', label: '高光强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_mid_hue', label: '中间调色相', min: 0, max: 360, step: 1, unit: '°' },
      { key: 'split_mid_sat', label: '中间调强度', min: 0, max: 1, step: 0.01, unit: '' },
      { key: 'split_balance', label: '平衡', min: 0, max: 1, step: 0.01, unit: '' },
    ],
  },
  {
    id: 'rgb', label: '分通道(RGB)', defaultOpen: false,
    sliders: [],
  },
]

// 折叠状态(组 id → 是否展开)
export function defaultGroupOpen() {
  const o = {}
  for (const g of PARAM_GROUPS) o[g.id] = g.defaultOpen
  return o
}

export const RGB_GROUPS = [
  { key: 'lift', label: 'RGB 偏移', min: -0.1, max: 0.1, step: 0.005 },
  { key: 'gamma', label: '中间调', min: 0.5, max: 1.5, step: 0.005 },
  { key: 'gain', label: 'RGB 增益', min: 0.5, max: 1.5, step: 0.005 },
]

export const RGB_CHANNELS = ['R', 'G', 'B']

export function groupSummary(g, params) {
  const defaults = defaultParams()
  const keys = g.id === 'rgb' ? RGB_GROUPS.map((r) => r.key) : g.sliders.map((sl) => sl.key)
  const changed = keys.filter((k) => {
    const v = params[k]
    if (Array.isArray(v)) return v.some((x, i) => Math.abs(x - defaults[k][i]) > 1e-9)
    return Math.abs(v - defaults[k]) > 1e-9
  })
  return changed.length ? `${changed.length} 项已调整` : ''
}

export function parameterLabel(key) {
  return PARAM_GROUPS.flatMap((group) => group.sliders).find((slider) => slider.key === key)?.label ||
    RGB_GROUPS.find((group) => group.key === key)?.label ||
    { base_photo_style: '输入基准', tone_map: '显示映射' }[key] ||
    key
}
