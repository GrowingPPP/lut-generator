/** Presentation only. Never modifies API errors, request identities or grading state. */
function hasStructuredFailure(raw) {
  const start = raw.search(/[\[{]/)
  if (start < 0) return false
  try {
    const value = JSON.parse(raw.slice(start))
    return value !== null && typeof value === 'object'
  } catch { return false }
}

export function describeError(error, fallback = '操作未完成，请检查当前条件后重试。') {
  const raw = typeof error === 'string' ? error : error?.message || ''
  let message = raw
  if (error?.status === 401) message = '登录已过期，请重新登录后继续。'
  else if (/Failed to fetch|NetworkError|Load failed|network request failed/i.test(raw))
    message = '暂时无法连接服务，请检查网络和服务状态后重试。'
  else if (hasStructuredFailure(raw) || /validation error|extra_forbidden|Traceback|input_value=|^\s*[\[{]|errors\.pydantic|\b(?:api[_-]?key|password|token|authorization)\s*[:=]/i.test(raw))
    message = error?.status === 422 ? '请求数据未被服务接受，请检查输入条件后重试。' : fallback
  else if (!raw || /^[\x00-\x7f]+$/.test(raw)) message = fallback
  const diagnostics = []
  if (Number.isInteger(error?.status)) diagnostics.push(`HTTP ${error.status}`)
  if (typeof error?.code === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(error.code)) diagnostics.push(`错误类型：${error.code}`)
  if (error?.accepted) diagnostics.push('服务可能已接受请求，请先查看原作业状态。')
  return { message, details: diagnostics.join(' · ') }
}

export function createNotice(message, options = {}, scopeId = null, id = 0) {
  const settings = typeof options === 'string' ? { tone: options } : options
  const tone = settings.tone || 'info'
  const description = tone === 'error' ? describeError(message, settings.fallback) : { message: String(message || ''), details: '' }
  return { ...settings, ...description, id, scopeId, tone,
    duration: tone === 'success' ? (settings.duration ?? 6000) : 0 }
}

export function noticeForScope(notice, scopeId) {
  return notice?.scopeId === scopeId && notice.message ? notice : null
}
