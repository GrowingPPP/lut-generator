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
export const me = () => jsonFetch(`${BASE}/auth/me`)
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

// 会话
export const listSessions = () => jsonFetch(`${BASE}/sessions`)
export const createSession = (title) =>
  jsonFetch(`${BASE}/sessions`, { method: 'POST', body: JSON.stringify({ title }) })
export const deleteSession = (id) => jsonFetch(`${BASE}/sessions/${id}`, { method: 'DELETE' })
export const updateSession = (id, title) =>
  jsonFetch(`${BASE}/sessions/${id}`, { method: 'PUT', body: JSON.stringify({ title }) })
export const listMessages = (sessionId) => jsonFetch(`${BASE}/sessions/${sessionId}/messages`)

// 聊天
export const chatSession = (message, params, history, sessionId) =>
  jsonFetch(`${BASE}/session/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, params, history, session_id: sessionId }),
  })
