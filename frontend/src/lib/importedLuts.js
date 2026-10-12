import { MAX_CUBE_BYTES, validateExternalId } from './cubeLut.js'
const cache = new Map()
const pending = new Map()
let generation = 0
async function request(path, options = {}, binary = false) {
  const response = await fetch(`/api/imported-luts${path}`, { ...options, credentials: 'include' })
  if (response.status === 401) { window.dispatchEvent(new Event('chroma:unauthorized')); throw new Error('登录已过期，请重新登录') }
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.detail === 'string' ? body.detail : body.detail?.message || `请求失败：${response.status}`) }
  return binary ? response.arrayBuffer() : response.json()
}
export const listImportedLuts = () => request('')
export async function importLut(file, contract) {
  if (!file || file.size > MAX_CUBE_BYTES) throw new Error('cube 文件需小于32MB')
  const data = new FormData()
  data.append('file', file)
  data.append('contract', JSON.stringify(contract))
  return request('', { method: 'POST', body: data })
}
export async function preloadExternalLut(id) {
  if (id === null || id === undefined) return null
  id = validateExternalId(id)
  if (cache.has(id)) return cache.get(id)
  if (pending.has(id)) return pending.get(id)
  const started = generation
  const loading = (async () => {
    const metadata = await request(`/${encodeURIComponent(id)}`)
    const bytes = await request(`/${encodeURIComponent(id)}/data`, {}, true)
    if (metadata.size < 2 || metadata.size > 65 || bytes.byteLength !== metadata.size ** 3 * 3 * 4) throw new Error('外部 LUT 数据长度不正确')
    const view = new DataView(bytes), data = new Float32Array(bytes.byteLength / 4)
    for (let i = 0; i < data.length; i++) { data[i] = view.getFloat32(i * 4, true); if (!Number.isFinite(data[i]) || data[i] < 0 || data[i] > 1) throw new Error('外部 LUT 数据非法') }
    const artifact = { ...metadata, data }
    if (started !== generation) throw new Error('账号或调色项目引用缓存已清除，请重新载入')
    return registerExternalLut(id, artifact)
  })()
  pending.set(id, loading)
  try { return await loading } finally { if (pending.get(id) === loading) pending.delete(id) }
}
export function resolveExternalLut(id) {
  if (id === null) return null
  id = validateExternalId(id)
  const artifact = cache.get(id)
  if (!artifact) throw new Error('外部 LUT 尚未载入或引用失效，效果未生成')
  return artifact
}
export function registerExternalLut(id, record) {
  id = validateExternalId(id)
  if (id === null || !record || validateExternalId(record.id) !== id || !Number.isInteger(record.size)
    || record.size < 2 || record.size > 65 || !(record.data instanceof Float32Array)
    || record.data.length !== record.size ** 3 * 3
    || !['sRGB', 'Rec709', 'VLOG'].includes(record.input_encoding) || !['sRGB', 'Rec709'].includes(record.output_encoding)
    || !(record.input_encoding === record.output_encoding || (record.input_encoding === 'VLOG' && record.output_encoding === 'Rec709'))
    || !Array.isArray(record.domain_min) || !Array.isArray(record.domain_max) || record.domain_min.length !== 3 || record.domain_max.length !== 3
    || record.domain_min.some((low, i) => !Number.isFinite(low) || !Number.isFinite(record.domain_max[i]) || low < 0 || record.domain_max[i] > 1 || low >= record.domain_max[i])
    || record.data.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('外部 LUT 数据或信号声明非法')
  const artifact = { ...record, id, domain_min: [...record.domain_min], domain_max: [...record.domain_max] }
  cache.set(id, artifact)
  return artifact
}
export function clearExternalLutCache() { generation++; cache.clear(); pending.clear() }
