export const COVER_OPTIONS = Object.freeze([
  { id: 'engine', label: '参数色彩图' },
  { id: 'amber', label: '暖光' },
  { id: 'teal', label: '青影' },
  { id: 'mono', label: '黑白' },
  { id: 'dusk', label: '暮色' },
])
export const DEFAULT_LIBRARY_FILTERS = Object.freeze({
  q: '',
  kind: '',
  input: '',
  favorite: '',
  group: 'all',
  sort: 'created_desc',
})
export const normalizeAsset = (asset) => ({
  ...asset,
  kind: asset.kind || 'full_snapshot',
  tags: Array.isArray(asset.tags) ? asset.tags : [],
  group: asset.group || null,
  favorite: Boolean(asset.favorite),
  cover_id: COVER_OPTIONS.some((c) => c.id === asset.cover_id)
    ? asset.cover_id
    : 'engine',
  updated_at: asset.updated_at || asset.created_at,
})
export function libraryQuery(filters = {}) {
  const query = {}
  if (filters.q?.trim()) query.q = filters.q.trim()
  if (filters.kind) query.kind = filters.kind
  if (filters.input) query.input = filters.input
  if (filters.favorite === true || filters.favorite === false)
    query.favorite = String(filters.favorite)
  else if (filters.favorite === 'true' || filters.favorite === 'false')
    query.favorite = filters.favorite
  if (filters.group === 'none') query.group = ''
  else if (filters.group?.startsWith('group:'))
    query.group = filters.group.slice(6)
  if (filters.sort) query.sort = filters.sort
  return query
}
export function parseTags(value) {
  const values = Array.isArray(value)
    ? value
    : String(value)
        .split(/[,，\n]/)
        .map((v) => v.trim())
        .filter(Boolean)
  const tags = []
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('标签必须是文本')
    const tag = value.trim()
    if (!tag || tag.length > 24 || /[\u0000-\u001f]/.test(tag))
      throw new Error('每个标签需要 1–24 个字符')
    if (!seen.has(tag.toLocaleLowerCase())) {
      tags.push(tag)
      seen.add(tag.toLocaleLowerCase())
    }
  }
  if (tags.length > 12) throw new Error('最多 12 个标签')
  return tags
}
export function metadataPatch(original, draft) {
  const current = normalizeAsset(original)
  const name = draft.name.trim()
  if (!name || name.length > 255) throw new Error('名称需要 1–255 个字符')
  const group = draft.group?.trim() || null
  if (group && group.length > 48) throw new Error('分组最多 48 个字符')
  if (draft.description.length > 4000)
    throw new Error('适用场景最多 4000 个字符')
  const values = {
    name,
    description: draft.description,
    tags: draft.tags === current.tags.join('，') ? current.tags : parseTags(draft.tags),
    group,
    favorite: Boolean(draft.favorite),
    cover_id: draft.cover_id,
  }
  const patch = {}
  for (const [field, value] of Object.entries(values)) {
    if (JSON.stringify(current[field]) !== JSON.stringify(value))
      patch[field] = value
  }
  return patch
}
export function assetMatches(asset, filters = {}) {
  const item = normalizeAsset(asset)
  const query = filters.q?.trim().toLocaleLowerCase()
  return (
    (!query ||
      [item.name, item.description, ...item.tags].some((v) =>
        v?.toLocaleLowerCase().includes(query),
      )) &&
    (!filters.kind || item.kind === filters.kind) &&
    (!filters.input ||
      (item.params?.base_photo_style || 'STD') === filters.input) &&
    (filters.favorite === '' ||
      filters.favorite == null ||
      item.favorite === (String(filters.favorite) === 'true')) &&
    (filters.group == null ||
      filters.group === 'all' ||
      (filters.group === 'none'
        ? !item.group
        : item.group === filters.group.slice(6)))
  )
}
