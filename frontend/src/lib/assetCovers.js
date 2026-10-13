export const COVER_MAX_BYTES = 300 * 1024
export const COVER_BUDGET_BYTES = 12 * 1024 * 1024
const keyFor = (owner, id) => JSON.stringify([String(owner), String(id)])
const identity = (owner, id) => {
  if (!owner || !id) throw new Error('照片封面需要有效账号与作品。')
  return keyFor(owner, id)
}
function nextRecord(records, owner, id, blob, retired = false) {
  const key = identity(owner, id)
  if (!retired && records.find(record => record.key === key)?.retired) throw new Error('作品已删除，不能重新保存封面。')
  if (blob && (!(blob instanceof Blob) || blob.type !== 'image/jpeg' || !blob.size || blob.size > COVER_MAX_BYTES))
    throw new Error('照片封面需要小于 300KB 的缩小 JPEG。')
  const size = records.filter(record => record.user_id === String(owner) && record.key !== key)
    .reduce((sum, record) => sum + (record.blob?.size || 0), blob?.size || 0)
  if (size > COVER_BUDGET_BYTES) throw new Error('本机照片封面超过 12MB，请先移除一些封面。')
  return { key, user_id: String(owner), asset_id: String(id), blob: blob || null, retired }
}
export function createCoverStorage({ indexedDB = globalThis.indexedDB } = {}) {
  let database
  const open = () => database || (database = new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('浏览器照片封面存储不可用。'))
    const request = indexedDB.open('chroma-asset-covers', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('covers', { keyPath: 'key' })
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('照片封面存储被其他标签页占用，请关闭后重试。'))
  }).catch(error => { database = null; throw error }))
  return {
    async get(owner, id) {
      const key = identity(owner, id), db = await open()
      return new Promise((resolve, reject) => {
        const request = db.transaction('covers').objectStore('covers').get(key)
        request.onsuccess = () => resolve(request.result?.retired ? null : request.result?.blob || null)
        request.onerror = () => reject(request.error)
      })
    },
    async put(owner, id, blob, { retired = false } = {}) {
      identity(owner, id)
      const db = await open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('covers', 'readwrite'), store = tx.objectStore('covers'), request = store.getAll()
        let failure
        request.onsuccess = () => {
          try { store.put(nextRecord(request.result, owner, id, blob, retired)) }
          catch (error) { failure = error; tx.abort() }
        }
        tx.oncomplete = () => resolve()
        tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('照片封面未能保存，请重试。'))
      })
    },
  }
}
export function createMemoryCoverStorage() {
  const records = new Map()
  return {
    async get(owner, id) { const record = records.get(identity(owner, id)); return record?.retired ? null : record?.blob || null },
    async put(owner, id, blob, { retired = false } = {}) {
      const record = nextRecord([...records.values()], owner, id, blob, retired)
      records.set(record.key, record)
    },
  }
}

// Browser colour decoding is only a cover illustration, never a grading input.
export async function photoCover(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file?.type) || file.size > 32 * 1024 * 1024)
    throw new Error('请选择 32MB 以内的 JPEG、PNG 或 WebP 照片。')
  const url = URL.createObjectURL(file), image = new Image()
  let canvas
  try {
    image.src = url
    await image.decode()
    if (image.naturalWidth * image.naturalHeight > 64_000_000) throw new Error('照片超过 6400 万像素，请先缩小。')
    const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight))
    canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .8))
    if (!blob || blob.size > COVER_MAX_BYTES) throw new Error('封面编码失败或文件仍过大，请选择其他照片。')
    return blob
  } finally { URL.revokeObjectURL(url); if (canvas) { canvas.width = 0; canvas.height = 0 } }
}
