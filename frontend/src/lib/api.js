// 后端 API client。认证用 httpOnly cookie,前端不持有 token。
import { libraryQuery } from './assetLibrary.js'

const BASE = '/api'

async function jsonFetch(url, opts = {}) {
  const { skip401Redirect, ...rest } = opts
  const headers = { 'Content-Type': 'application/json', ...(rest.headers || {}) }
  const res = await fetch(url, { ...rest, headers, credentials: 'include' })
  if (res.status === 401 && !skip401Redirect) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw Object.assign(new Error('登录已过期,请重新登录'), { status: 401 })
  }
  if (!res.ok) {
    let detail = `请求失败: ${res.status}`
    let code
    let accepted
    try {
      const data = await res.json()
      if (data.detail) {
        detail = typeof data.detail === 'string' ? data.detail : data.detail.message || JSON.stringify(data.detail)
        code = data.detail?.code
        accepted = data.detail?.accepted
      }
    } catch {
      // 忽略非 JSON 错误体
    }
    const error = new Error(detail)
    error.status = res.status
    error.code = code
    error.accepted = accepted
    throw error
  }
  if (res.status === 204) return null
  return res.json()
}

// 认证
export const register = (username, password) =>
  jsonFetch(`${BASE}/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    skip401Redirect: true,
  })
export const login = (username, password) =>
  jsonFetch(`${BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    skip401Redirect: true,
  })
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

// 松下 FAT32 机内导入要求文件主名不超过 8 位且只用字母数字。
export function cameraFileName(name) {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(name)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return `${hash.toString(16).toUpperCase().padStart(8, '0')}.cube`
}

// LUT
export const listLuts = (filters = {}) => {
  const query = new URLSearchParams(libraryQuery(filters)).toString()
  return jsonFetch(`${BASE}/luts${query ? `?${query}` : ''}`)
}
export const getLibrarySummary = () => jsonFetch(`${BASE}/luts/summary`)
export const createLut = (name, description, params, metadata = {}) =>
  jsonFetch(`${BASE}/luts`, {
    method: 'POST',
    body: JSON.stringify({ name, description, params, ...metadata }),
  })
export const updateLut = (id, data) =>
  jsonFetch(`${BASE}/luts/${id}`, { method: 'PUT', body: JSON.stringify(data) })
export const updateLutMetadata = (id, data) =>
  jsonFetch(`${BASE}/luts/${id}/metadata`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteLut = (id) => jsonFetch(`${BASE}/luts/${id}`, { method: 'DELETE' })
export const listLutRevisions = (id) => jsonFetch(`${BASE}/luts/${id}/revisions`)

// 下载 .cube(带 cookie)
export async function downloadLut(id, mode = 'camera', target = 'neutral', params, revisionId) {
  const res = await fetch(
    `${BASE}/luts/${id}/download?mode=${mode}&target=${target}${revisionId ? `&revision_id=${revisionId}` : ''}`,
    {
      credentials: 'include',
      ...(params
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, target, params }),
          }
        : {}),
    },
  )
  if (res.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw Object.assign(new Error('登录已过期,请重新登录'), { status: 401 })
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
export const chatSession = (message, params, history, sessionId, editing = {}) =>
  jsonFetch(`${BASE}/session/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, params, history, session_id: sessionId, ...editing }),
  })

// 取最近一次自动修图报告(刷新或重开会话后重建面板用)。没有记录时返回 null。
export async function getAutoReport(workspaceId) {
  const res = await fetch(
    `${BASE}/auto/report${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''}`,
    { credentials: 'include' },
  )
  if (res.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    return null
  }
  if (!res.ok) return null
  return res.json()
}

export const undoAutoGrade = () => jsonFetch(`${BASE}/auto/undo`, { method: 'POST' })

export async function analyzePhotoSubjects({ file, params, source_digest, enabled = true }) {
  const body = new FormData()
  body.append('file', file)
  body.append('input_style', params.base_photo_style)
  body.append('tone_map', String(params.tone_map ?? 1))
  body.append('params', JSON.stringify(params))
  body.append('source_digest', source_digest)
  body.append('enabled', String(enabled))
  const response = await fetch(`${BASE}/photos/subjects`, { method: 'POST', body, credentials: 'include' })
  if (response.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw Object.assign(new Error('登录已过期，请重新登录'), { status: 401 })
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || `人物识别失败：${response.status}`),
      { status: response.status })
  }
  return response.json()
}

// 自动修图。multipart 提交,base_params 必填(服务端拒绝默认值兜底)。
async function submitAutoGrade(path, {
  file,
  params,
  style,
  useVision = true,
  maxRounds,
  context,
  workspace_id,
  source_digest,
  main_sample_id,
  sample_origin = 'source',
  request_id,
  continue_from,
}) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('base_params', JSON.stringify(params))
  if (style && style.trim()) fd.append('style', style.trim())
  fd.append('use_vision', String(useVision))
  if (maxRounds) fd.append('max_rounds', String(maxRounds))
  if (context) fd.append('context', JSON.stringify(context))
  if (workspace_id) fd.append('workspace_id', workspace_id)
  if (source_digest) fd.append('source_digest', source_digest)
  if (main_sample_id) fd.append('main_sample_id', main_sample_id)
  fd.append('sample_origin', sample_origin)
  if (request_id) fd.append('request_id', request_id)
  if (continue_from) fd.append('continue_from', continue_from)
  // 不要手写 Content-Type:让浏览器带上 multipart boundary
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
  })
  if (res.status === 401) {
    window.dispatchEvent(new Event('chroma:unauthorized'))
    throw Object.assign(new Error('登录已过期,请重新登录'), { status: 401 })
  }
  if (!res.ok) {
    let detail = `修图失败: ${res.status}`
    let code, accepted
    try {
      const data = await res.json()
      if (data.detail) {
        detail = typeof data.detail === 'string' ? data.detail : data.detail.message || JSON.stringify(data.detail)
        code = data.detail?.code
        accepted = data.detail?.accepted
      }
    } catch {
      // 忽略非 JSON 错误体
    }
    const error = new Error(detail)
    error.status = res.status
    error.code = code
    error.accepted = accepted
    throw error
  }
  return res.json()
}

export const autoGrade = (request) => submitAutoGrade('/auto/grade', request)
export const startAutoJob = (request) => submitAutoGrade('/auto/jobs', request)
export const getAutoJob = (id, workspaceId) => jsonFetch(`${BASE}/auto/jobs/${encodeURIComponent(id)}${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''}`)
export const cancelAutoJob = (id, { workspaceId, preventLate = false } = {}) => {
  const query = new URLSearchParams()
  if (workspaceId) query.set('workspace_id', workspaceId)
  if (preventLate) query.set('prevent_late', 'true')
  return jsonFetch(`${BASE}/auto/jobs/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`, { method: 'DELETE' })
}

export const listWorkspaces = () => jsonFetch(`${BASE}/workspaces`)
export const createWorkspace = (data) =>
  jsonFetch(`${BASE}/workspaces`, { method: 'POST', body: JSON.stringify(data) })
export const updateWorkspace = (id, data) =>
  jsonFetch(`${BASE}/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const listVersions = (id) => jsonFetch(`${BASE}/workspaces/${id}/versions`)
export const createVersion = (id, data) =>
  jsonFetch(`${BASE}/workspaces/${id}/versions`, { method: 'POST', body: JSON.stringify(data) })
export const renameVersion = (workspaceId, id, name) =>
  jsonFetch(`${BASE}/workspaces/${workspaceId}/versions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
export const deleteVersion = (workspaceId, id) =>
  jsonFetch(`${BASE}/workspaces/${workspaceId}/versions/${id}`, { method: 'DELETE' })
export async function applyLut(id, data, file) {
  if (!file)
    return jsonFetch(`${BASE}/luts/${id}/apply`, { method: 'POST', body: JSON.stringify(data) })
  const fd = new FormData()
  fd.append('body', JSON.stringify(data))
  fd.append('file', file, 'main-preview.jpg')
  const res = await fetch(`${BASE}/luts/${id}/apply-validated`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
  })
  if (res.status === 401) window.dispatchEvent(new Event('chroma:unauthorized'))
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(
      typeof error.detail === 'string'
        ? error.detail
        : error.detail?.message || JSON.stringify(error.detail || `应用失败：${res.status}`),
    )
  }
  return res.json()
}

export async function validateWorkspace(id, params, samples, files) {
  const fd = new FormData()
  fd.append('params', JSON.stringify(params))
  fd.append('samples', JSON.stringify(samples))
  files.forEach((file, i) => fd.append('files', file, `${samples[i].id}.jpg`))
  const res = await fetch(`${BASE}/workspaces/${id}/validate`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
  })
  if (res.status === 401) window.dispatchEvent(new Event('chroma:unauthorized'))
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(
      typeof data.detail === 'string'
        ? data.detail
        : JSON.stringify(data.detail || `验证失败：${res.status}`),
    )
  }
  return res.json()
}
