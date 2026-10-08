// 自动修图的展示层纯函数。
//
// 抽出来单独放,是为了能脱离 React 单测(项目已有零依赖脚本先例:
// frontend/scripts/check_parity.mjs,用 Node 内置 node:test)。
// 这些函数把服务端的技术字段翻译成中文,任何一处漏翻译都会把原始键名甩给用户。

// 22 个参数的展示名与单位。改参数集时这里必须同步 —— 有测试锁住覆盖率。
export const PARAM_LABELS = {
  base_photo_style: ['基准', ''],
  tone_map: ['高光映射', ''],
  temp: ['色温', 'K'],
  tint: ['色调', ''],
  exposure: ['曝光', ' EV'],
  contrast: ['对比度', ''],
  highlights: ['高光', ''],
  shadows: ['阴影', ''],
  whites: ['白场', ''],
  blacks: ['黑场', ''],
  curve: ['S 曲线', ''],
  saturation: ['饱和度', ''],
  vibrance: ['自然饱和', ''],
  hue: ['色相', '°'],
  split_shadow_hue: ['阴影色相', '°'],
  split_shadow_sat: ['阴影强度', ''],
  split_highlight_hue: ['高光色相', '°'],
  split_highlight_sat: ['高光强度', ''],
  split_balance: ['平衡', ''],
  lift: ['暗部 RGB', ''],
  gamma: ['中间调 RGB', ''],
  gain: ['亮部 RGB', ''],
}

const ARRAY_KEYS = ['lift', 'gamma', 'gain']

function fmtNumber(key, value) {
  const [, unit] = PARAM_LABELS[key] || ['', '']
  if (unit === 'K' || unit === '°') return String(Math.round(value))
  // 这些增量本来就在 0.01 量级,取整会把 0.06 显示成 0
  return value.toFixed(2)
}

// 构造 multipart 表单之外的轻量封装:便于测试断言字段齐全
export function buildAutoGradePayload({ params, style, useVision = true, maxRounds }) {
  const payload = { base_params: { ...params }, use_vision: Boolean(useVision) }
  const trimmed = (style || '').trim()
  if (trimmed) payload.style = trimmed
  if (maxRounds) payload.max_rounds = maxRounds
  return payload
}

// 服务端返回的 steps → UI 的中文步骤列表(顺序固定为 4 步)
export function summarizeSteps(steps, { hasStyle, hasVision }) {
  const out = []
  const list = steps || []

  const measure = list.find((s) => s.stage === 'optimize' && s.round === 1)
  out.push({
    key: 'measure',
    title: '测量照片',
    detail: measure && measure.diagnosis ? measure.diagnosis : '',
    state: 'done',
  })

  const applied = list.filter((s) => s.stage === 'optimize' && s.applied)
  const rejected = list.filter((s) => s.stage === 'optimize' && !s.applied && s.rejections?.length)
  const parts = []
  if (applied.length) parts.push(`${applied.length} 轮修正已应用`)
  if (rejected.length) parts.push(`${rejected.length} 轮被安全规则拦下`)
  out.push({
    key: 'optimize',
    title: '修正影调与色彩',
    detail: parts.join(' · ') || (measure ? '无需修正' : ''),
    state: 'done',
  })

  const styleStep = list.find((s) => s.stage === 'style')
  out.push({
    key: 'style',
    title: '风格化',
    detail: !hasStyle
      ? '未指定风格'
      : (styleStep ? (styleStep.applied ? '已应用风格' : '风格被安全规则拦下') : ''),
    state: hasStyle ? 'done' : 'skipped',
  })

  out.push({
    key: 'review',
    title: '视觉复核',
    detail: hasVision ? '' : '已关闭视觉复核',
    state: hasVision ? 'done' : 'skipped',
  })
  return out
}

// 只列出真正变化的字段,用于「本次调整」摘要
export function diffParams(before, after) {
  const out = []
  if (!before || !after) return out
  for (const key of Object.keys(after)) {
    const [label, unit] = PARAM_LABELS[key] || [key, '']
    const a = before[key]
    const b = after[key]
    if (Array.isArray(b)) {
      const prev = Array.isArray(a) ? a : [0, 0, 0]
      const deltas = b.map((v, i) => v - prev[i])
      if (deltas.every((d) => Math.abs(d) < 1e-6)) continue
      const body = deltas.map((d) => (d >= 0 ? '+' : '') + d.toFixed(2)).join('/')
      out.push({ key, label, text: `${label} ${body}`, delta: deltas })
      continue
    }
    if (typeof b === 'number' && typeof a === 'number') {
      const d = b - a
      if (Math.abs(d) < 1e-9) continue
      let text = `${label} ${d > 0 ? '+' : ''}${fmtNumber(key, d)}${unit}`
      // 色温正=暖 / 负=冷,补方向词 —— 否则用户得自己换算符号
      if (key === 'temp') text += d > 0 ? '(偏暖)' : '(偏冷)'
      out.push({ key, label, text, delta: d })
      continue
    }
    if (a !== b) out.push({ key, label, text: `${label} ${b}`, delta: null })
  }
  return out
}

// 报告顶部的一句话结论
export function gradeHeadline(result) {
  if (!result) return ''
  if (result.degraded) return '未能完全达标,已采用保守调整'
  const n = (result.steps || []).filter((s) => s.applied).length
  if (n === 0) return '照片状态良好,无需明显调整'
  return `已应用 ${n} 步调整`
}

export function rejectionList(steps) {
  const out = []
  for (const s of steps || []) {
    for (const r of s.rejections || []) out.push(r)
  }
  return out
}
