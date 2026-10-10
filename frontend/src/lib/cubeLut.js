export const MAX_CUBE_BYTES = 32 * 1024 * 1024
const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export function validateExternalId(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('外部 LUT 引用必须是账号内的 UUID')
  return value.toLowerCase()
}
export function validateExternalOptions(id, strength, mode, basePhotoStyle) {
  validateExternalId(id)
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('外部 LUT 强度必须为 0–1')
  if (!['display', 'input'].includes(mode)) throw new Error('外部 LUT 模式无效')
  if (id === null && (strength !== 0 || mode !== 'display')) throw new Error('没有外部 LUT 时必须使用 display 和零强度')
  if (mode === 'input' && (strength !== 1 || basePhotoStyle !== 'VLOG')) throw new Error('输入转换仅支持 VLOG 且固定强度为 1')
}
function numbers(tokens) {
  if (tokens.length !== 3 || tokens.some(token => !numberToken.test(token) || !Number.isFinite(Number(token)))) throw new Error('cube 每行需包含三个有限数字')
  return tokens.map(Number)
}
export function parseCube(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_CUBE_BYTES) throw new Error('cube 文件需小于 32MB')
  const seen = new Set(), rows = []
  let size, title = '', domain_min = [0, 0, 0], domain_max = [1, 1, 1]
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const words = line.split(/\s+/), key = words[0]
    if (['TITLE', 'LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX'].includes(key)) {
      if (rows.length || seen.has(key)) throw new Error('cube 头信息不能重复或出现在数据之后')
      seen.add(key)
      if (key === 'TITLE') {
        const value = line.slice(5).trim()
        if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"' || /["\x00-\x1f]/.test(value.slice(1, -1)) || [...value.slice(1, -1)].length > 255) throw new Error('TITLE 需为最多255字符的引号文本')
        title = value.slice(1, -1)
      } else if (key === 'LUT_3D_SIZE') {
        if (words.length !== 2 || !/^\d+$/.test(words[1]) || Number(words[1]) < 2 || Number(words[1]) > 65) throw new Error('仅支持 2–65 点三维 cube')
        size = Number(words[1])
      } else if (key === 'DOMAIN_MIN') domain_min = numbers(words.slice(1))
      else domain_max = numbers(words.slice(1))
    } else {
      if (!numberToken.test(key)) throw new Error('仅支持纯三维 cube,不支持 1D、混合、HDR 或其他头格式')
      if (!size) throw new Error('数据之前必须声明 LUT_3D_SIZE')
      const row = numbers(words)
      if (row.some(value => value < 0 || value > 1)) throw new Error('仅支持输出范围为 0–1 的 SDR LUT')
      rows.push(row)
      if (rows.length > size ** 3) throw new Error('cube 数据行数超过声明点数')
    }
  }
  if (!size || rows.length !== size ** 3) throw new Error('cube 数据行数必须恰好为 N³')
  if (domain_min.some((low, i) => low < 0 || domain_max[i] > 1 || low >= domain_max[i])) throw new Error('SDR DOMAIN 需位于 0–1 且每通道最小值小于最大值')
  return { size, title, domain_min, domain_max, data: new Float32Array(rows.flat()) }
}
export function sampleImportedLut(lut, r, g, b) {
  const source = [r, g, b], pos = source.map((value, i) => Math.max(0, Math.min(1, (value - lut.domain_min[i]) / (lut.domain_max[i] - lut.domain_min[i]))) * (lut.size - 1))
  const low = pos.map(Math.floor), high = low.map(value => Math.min(lut.size - 1, value + 1)), f = pos.map((value, i) => value - low[i])
  const out = [0, 0, 0]
  for (let dr = 0; dr < 2; dr++) for (let dg = 0; dg < 2; dg++) for (let db = 0; db < 2; db++) {
    const indices = [dr, dg, db], xyz = indices.map((upper, i) => upper ? high[i] : low[i]), weight = indices.reduce((value, upper, i) => value * (upper ? f[i] : 1 - f[i]), 1)
    const offset = (xyz[2] * lut.size * lut.size + xyz[1] * lut.size + xyz[0]) * 3
    for (let channel = 0; channel < 3; channel++) out[channel] += lut.data[offset + channel] * weight
  }
  return out.map(value => Math.max(0, Math.min(1, value)))
}
