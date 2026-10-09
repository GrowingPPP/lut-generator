// 后端 API client。认证用 httpOnly cookie,前端不持有 token。
const BASE = '/api'

async function jsonFetch(url, opts = {}) {
  const { skip401Redirect, ...rest } = opts
  const headers = { 'Content-Type': 'application/json', ...(rest.headers || {}) }
  const res = await fetch(url, { ...rest, headers, credentials: 'include' })
  if (res.status === 401 && !skip401Redirect) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw new Error('登录已过期,请重新登录')
  }
  if (!res.ok) {
    let detail = `请求失败: ${res.status}`
    try {
      const data = await res.json()
      if (data.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
    } catch {
      // 忽略非 JSON 错误体
    }
    throw new Error(detail)
  }
  if (res.status === 204) return null
  return res.json()
}

// 认证
export const register = (username, password) =>
  jsonFetch(`${BASE}/auth/register`, { method: 'POST', body: JSON.stringify({ username, password }), skip401Redirect: true })
export const login = (username, password) =>
  jsonFetch(`${BASE}/auth/login`, { method: 'POST', body: JSON.stringify({ username, password }), skip401Redirect: true })
// 「我是谁」是一次探测:未登录时后端返回 401 是正常结果,不是错误。
// 这里把 401 当作「未登录」(返回 null),并且**不派发 chroma:unauthorized** ——
// 后者会清空刚建立的登录态。
//
// 已知的良性噪音:浏览器 DevTools 会把这次 401 记成一条 error 级
// "Failed to load resource: 401"。那是**网络层的原生记录**,与代码怎么处理无关,
// 也让 status code 保持应有的语义(未认证就是 401)。
// 曾试过「没有 cookie 就不发这次请求」来消除它,但会话 cookie 是 **httpOnly**,
// document.cookie 根本读不到 —— 那个改动会让所有人刷新后掉登录态,已回退。
export const me = async () => {
  const res = await fetch(`${BASE}/auth/me`, { credentials: 'include' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(`请求失败: ${res.status}`)
  return res.json()
}
export const logout = () => jsonFetch(`${BASE}/auth/logout`, { method: 'POST' })

// LUT
export const listLuts = () => jsonFetch(`${BASE}/luts`)
export const createLut = (name, description, params) =>
  jsonFetch(`${BASE}/luts`, { method: 'POST', body: JSON.stringify({ name, description, params }) })
export const updateLut = (id, data) =>
  jsonFetch(`${BASE}/luts/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteLut = (id) => jsonFetch(`${BASE}/luts/${id}`, { method: 'DELETE' })

// 下载 .cube(带 cookie)
export async function downloadLut(id, mode = 'camera') {
  const res = await fetch(`${BASE}/luts/${id}/download?mode=${mode}`, { credentials: 'include' })
  if (res.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw new Error('登录已过期,请重新登录')
  }
  if (!res.ok) throw new Error(`下载失败: ${res.status}`)
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') || ''
  let name = `${id}_${mode}.cube`
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i)
  if (m) name = decodeURIComponent(m[1])
  return { blob, name }
}

// 触发浏览器保存文本内容为文件
function safeFileName(name) {
  // 去掉路径分隔符与控制字符,避免下载名被用作路径
  const cleaned = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
  return cleaned || 'lut.cube'
}

export function saveTextFile(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = safeFileName(name)
  a.click()
  URL.revokeObjectURL(url)
}

// 会话
export const listSessions = () => jsonFetch(`${BASE}/sessions`)
export const createSession = (title) =>
  jsonFetch(`${BASE}/sessions`, { method: 'POST', body: JSON.stringify({ title }) })
export const deleteSession = (id) => jsonFetch(`${BASE}/sessions/${id}`, { method: 'DELETE' })
export const updateSession = (id, title) =>
  jsonFetch(`${BASE}/sessions/${id}`, { method: 'PUT', body: JSON.stringify({ title }) })
export const listMessages = (sessionId) => jsonFetch(`${BASE}/sessions/${sessionId}/messages`)
export const getGeneratedLut = (sessionId) => jsonFetch(`${BASE}/sessions/${sessionId}/generated`)

// 聊天
export const chatSession = (message, params, history, sessionId) =>
  jsonFetch(`${BASE}/session/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, params, history, session_id: sessionId }),
  })

// 取最近一次自动修图报告(刷新或重开会话后重建面板用)。没有记录时返回 null。
export async function getAutoReport() {
  const res = await fetch(`${BASE}/auto/report`, { credentials: 'include' })
  if (res.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    return null
  }
  if (!res.ok) return null
  return res.json()
}

// 自动修图。multipart 提交,base_params 必填(服务端拒绝默认值兜底)。
export async function autoGrade({ file, params, style, useVision = true, maxRounds }) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('base_params', JSON.stringify(params))
  if (style && style.trim()) fd.append('style', style.trim())
  fd.append('use_vision', String(useVision))
  if (maxRounds) fd.append('max_rounds', String(maxRounds))
  // 不要手写 Content-Type:让浏览器带上 multipart boundary
  const res = await fetch(`${BASE}/auto/grade`, {
    method: 'POST', body: fd, credentials: 'include',
  })
  if (res.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw new Error('登录已过期,请重新登录')
  }
  if (!res.ok) {
    let detail = `修图失败: ${res.status}`
    try {
      const data = await res.json()
      if (data.detail) detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
    } catch {
      // 忽略非 JSON 错误体
    }
    throw new Error(detail)
  }
  return res.json()
}
