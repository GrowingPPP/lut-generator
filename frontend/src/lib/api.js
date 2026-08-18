// 后端 API client。
const BASE = '/api'

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`请求失败: ${res.status}`)
  if (res.status === 204) return null
  return res.json()
}

export const listLuts = () => jsonFetch(`${BASE}/luts`)

export const createLut = (name, description, params) =>
  jsonFetch(`${BASE}/luts`, {
    method: 'POST',
    body: JSON.stringify({ name, description, params }),
  })

export const updateLut = (id, data) =>
  jsonFetch(`${BASE}/luts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteLut = (id) => jsonFetch(`${BASE}/luts/${id}`, { method: 'DELETE' })

export const downloadUrl = (id, mode = 'camera') =>
  `${BASE}/luts/${id}/download?mode=${mode}`

export const chatSession = (message, params, history) =>
  jsonFetch(`${BASE}/session/chat`, {
    method: 'POST',
    body: JSON.stringify({ message, params, history }),
  })
