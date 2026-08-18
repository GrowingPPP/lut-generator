// 后端 API client。带 JWT 认证。
const BASE = '/api'

function getToken() {
  return localStorage.getItem('chroma_token')
}

export function setToken(token, username) {
  localStorage.setItem('chroma_token', token)
  localStorage.setItem('chroma_username', username)
}

export function clearToken() {
  localStorage.removeItem('chroma_token')
  localStorage.removeItem('chroma_username')
}

export function getUsername() {
  return localStorage.getItem('chroma_username') || ''
}

export function isAuthed() {
  return !!getToken()
}

async function jsonFetch(url, opts = {}) {
  const { skip401Redirect, ...rest } = opts
  const headers = { 'Content-Type': 'application/json', ...(rest.headers || {}) }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { ...rest, headers })
  if (res.status === 401 && !skip401Redirect) {
    clearToken()
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

// LUT
export const listLuts = () => jsonFetch(`${BASE}/luts`)
export const createLut = (name, description, params) =>
  jsonFetch(`${BASE}/luts`, { method: 'POST', body: JSON.stringify({ name, description, params }) })
export const updateLut = (id, data) =>
  jsonFetch(`${BASE}/luts/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const deleteLut = (id) => jsonFetch(`${BASE}/luts/${id}`, { method: 'DELETE' })

// 下载 .cube(带 token,用 fetch + blob)
export async function downloadLut(id, mode = 'camera') {
  const token = getToken()
  const res = await fetch(`${BASE}/luts/${id}/download?mode=${mode}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) {
    clearToken()
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
export const listMessages = (sessionId) => jsonFetch(`${BASE}/sessions/${sessionId}/messages`)

// 聊天
export const chatSession = (message, params, history, sessionId) =>
  jsonFetch(`${BASE}/session/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, params, history, session_id: sessionId }),
  })
