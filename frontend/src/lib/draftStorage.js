import { domainError } from './styleRecipe.js'

export const PREVIEW_BUDGET_BYTES = 24 * 1024 * 1024
export const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DB_NAME = 'chroma-workspaces'
const keyFor = (userId, workspaceId) => JSON.stringify([String(userId ?? 'guest'), workspaceId])
const owned = (record, userId, workspaceId) => record.user_id === String(userId ?? 'guest') && (!workspaceId || record.workspace_id === workspaceId)

export class DraftConflictError extends Error {
  constructor(actualRevision) {
    super('另一标签页已更新此草稿，请载入最新内容或另存本机副本')
    this.name = 'DraftConflictError'; this.code = 'revision_conflict'; this.actualRevision = actualRevision
  }
}

function openDatabase(indexedDB) {
  if (!indexedDB) return Promise.reject(domainError('storage_unavailable', '浏览器本机草稿存储不可用'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('previews')) db.createObjectStore('previews', { keyPath: 'key' })
    }
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error || new Error('本机存储打开失败'))
    request.onblocked = () => reject(domainError('storage_blocked', '请关闭占用旧存储格式的其他标签页后重试'))
  })
}

export function createDraftStorage({ indexedDB = globalThis.indexedDB, now = () => Date.now() } = {}) {
  let database
  const getDb = () => database || (database = openDatabase(indexedDB).catch((error) => { database = null; throw error }))
  async function read(storeName, callback) {
    const db = await getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly')
      const request = callback(tx.objectStore(storeName))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      tx.onabort = () => reject(tx.error || new Error('本机读取失败'))
    })
  }
  const storage = {
    async load(userId, workspaceId) {
      const result = await read('drafts', (store) => store.get(keyFor(userId, workspaceId)))
      return result?.record || null
    },
    async list(userId) {
      const records = await read('drafts', (store) => store.getAll())
      return records.filter((item) => owned(item, userId)).map((item) => item.record).sort((a, b) => b.workspace.updated_at - a.workspace.updated_at)
    },
    async latest(userId, sessionId) {
      const records = await storage.list(userId)
      return records.find((record) => sessionId == null || record.workspace.session_id === sessionId) || null
    },
    async save(userId, record, expectedRevision = 0) {
      if (record.workspace.user_id !== String(userId ?? 'guest')) throw domainError('invalid_owner', '不能保存其他账号的草稿')
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite')
        const store = tx.objectStore('drafts')
        const key = keyFor(userId, record.workspace.id)
        const request = store.get(key)
        let result; let failure
        request.onsuccess = () => {
          const actualRevision = request.result?.record.workspace.revision || 0
          if (actualRevision !== expectedRevision) { failure = new DraftConflictError(actualRevision); tx.abort(); return }
          result = structuredClone(record)
          result.workspace.revision = actualRevision + 1
          result.workspace.updated_at = now()
          store.put({ key, user_id: String(userId ?? 'guest'), workspace_id: result.workspace.id, record: result })
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(failure || tx.error || new Error('本机草稿保存失败'))
        tx.onabort = () => reject(failure || tx.error || new Error('本机草稿保存被中止'))
      })
    },
    async putPreview(userId, workspaceId, sampleId, blob, metadata = {}) {
      if (!(blob instanceof Blob)) throw domainError('invalid_preview', '样张缓存必须是缩小预览文件')
      if (blob.size > PREVIEW_BUDGET_BYTES) throw domainError('preview_capacity', '本工作区的预览缓存超过 24MB')
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('previews', 'readwrite')
        const store = tx.objectStore('previews')
        const request = store.getAll()
        let failure; let result
        request.onsuccess = () => {
          const key = keyFor(userId, `${workspaceId}:${sampleId}`)
          const entries = request.result
          for (const entry of entries) if (entry.expires_at <= now()) store.delete(entry.key)
          const size = entries.filter((entry) => owned(entry, userId, workspaceId) && entry.expires_at > now() && entry.key !== key)
            .reduce((sum, entry) => sum + entry.blob.size, blob.size)
          if (size > PREVIEW_BUDGET_BYTES) { failure = domainError('preview_capacity', '本工作区的预览缓存超过 24MB'); tx.abort(); return }
          result = { key, user_id: String(userId ?? 'guest'), workspace_id: workspaceId, sample_id: sampleId,
            blob, metadata, created_at: now(), expires_at: now() + PREVIEW_TTL_MS }
          store.put(result)
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(failure || tx.error || new Error('样张预览保存失败'))
        tx.onabort = () => reject(failure || tx.error || new Error('样张预览保存被中止'))
      })
    },
    async getPreview(userId, workspaceId, sampleId) {
      const entry = await read('previews', (store) => store.get(keyFor(userId, `${workspaceId}:${sampleId}`)))
      return entry && entry.expires_at > now() ? entry : null
    },
    async clearPreviews(userId, workspaceId) {
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('previews', 'readwrite')
        const store = tx.objectStore('previews'); const request = store.getAll()
        request.onsuccess = () => request.result.filter((entry) => owned(entry, userId, workspaceId)).forEach((entry) => store.delete(entry.key))
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error)
      })
    },
  }
  return storage
}

// The same contract permits deterministic revision and cache tests without a DOM
// or an IndexedDB polyfill. Production always uses the browser adapter above.
export function createMemoryDraftStorage({ now = () => Date.now() } = {}) {
  const drafts = new Map(); const previews = new Map()
  const storage = {
    async load(userId, id) { return structuredClone(drafts.get(keyFor(userId, id)) || null) },
    async list(userId) {
      return [...drafts.values()].filter((record) => record.workspace.user_id === String(userId ?? 'guest'))
        .map((record) => structuredClone(record)).sort((a, b) => b.workspace.updated_at - a.workspace.updated_at)
    },
    async latest(userId, sessionId) { return (await storage.list(userId)).find((record) => sessionId == null || record.workspace.session_id === sessionId) || null },
    async save(userId, record, expectedRevision = 0) {
      if (record.workspace.user_id !== String(userId ?? 'guest')) throw domainError('invalid_owner', '不能保存其他账号的草稿')
      const key = keyFor(userId, record.workspace.id)
      const actualRevision = drafts.get(key)?.workspace.revision || 0
      if (actualRevision !== expectedRevision) throw new DraftConflictError(actualRevision)
      const saved = structuredClone(record)
      saved.workspace.revision = actualRevision + 1; saved.workspace.updated_at = now()
      drafts.set(key, saved)
      return structuredClone(saved)
    },
    async putPreview(userId, workspaceId, sampleId, blob, metadata = {}) {
      if (!(blob instanceof Blob)) throw domainError('invalid_preview', '样张缓存必须是缩小预览文件')
      const key = keyFor(userId, `${workspaceId}:${sampleId}`)
      for (const [entryKey, entry] of previews) if (entry.expires_at <= now()) previews.delete(entryKey)
      const size = [...previews.values()].filter((entry) => owned(entry, userId, workspaceId) && entry.key !== key)
        .reduce((sum, entry) => sum + entry.blob.size, blob.size)
      if (size > PREVIEW_BUDGET_BYTES) throw domainError('preview_capacity', '本工作区的预览缓存超过 24MB')
      const entry = { key, user_id: String(userId ?? 'guest'), workspace_id: workspaceId, sample_id: sampleId,
        blob, metadata: structuredClone(metadata), created_at: now(), expires_at: now() + PREVIEW_TTL_MS }
      previews.set(key, entry); return structuredClone(entry)
    },
    async getPreview(userId, workspaceId, sampleId) {
      const entry = previews.get(keyFor(userId, `${workspaceId}:${sampleId}`))
      return entry && entry.expires_at > now() ? structuredClone(entry) : null
    },
    async clearPreviews(userId, workspaceId) { for (const [key, entry] of previews) if (owned(entry, userId, workspaceId)) previews.delete(key) },
  }
  return storage
}

export function draftBackup(record) {
  return JSON.stringify({ ...record, exported_at: new Date().toISOString() }, null, 2)
}
