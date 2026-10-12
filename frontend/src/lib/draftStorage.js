import { domainError } from './styleRecipe.js'
import { createProjectDeletionJournal } from './projectManagement.js'

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

export function createDraftStorage({ indexedDB = globalThis.indexedDB, now = () => Date.now(), deletionJournal = createProjectDeletionJournal() } = {}) {
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
      if (deletionJournal.has(userId, workspaceId)) return null
      const result = await read('drafts', (store) => store.get(keyFor(userId, workspaceId)))
      return !deletionJournal.has(userId, workspaceId) && !result?.deleted_at ? result?.record || null : null
    },
    async list(userId) {
      const records = await read('drafts', (store) => store.getAll())
      return records.filter((item) => owned(item, userId) && item.record && !item.deleted_at && !deletionJournal.has(userId, item.workspace_id)).map((item) => item.record).sort((a, b) => b.workspace.updated_at - a.workspace.updated_at)
    },
    async latest(userId, sessionId) {
      const records = await storage.list(userId)
      return records.find((record) => sessionId == null || record.workspace.session_id === sessionId) || null
    },
    async isDeleted(userId, workspaceId) {
      if (deletionJournal.has(userId, workspaceId)) return true
      return Boolean((await read('drafts', store => store.get(keyFor(userId, workspaceId))))?.deleted_at)
    },
    async deletedIds(userId) {
      let records
      try { records = await read('drafts', store => store.getAll()) }
      catch (failure) { const ids = deletionJournal.ids(userId); if (ids.length) return ids; throw failure }
      return [...new Set([...deletionJournal.ids(userId), ...records.filter(item => owned(item, userId) && item.deleted_at).map(item => item.workspace_id)])]
    },
    async retire(userId, workspaceId) {
      const journalPersisted = deletionJournal.mark(userId, workspaceId)
      try {
        const db = await getDb()
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['drafts', 'previews'], 'readwrite')
          tx.objectStore('drafts').put({ key: keyFor(userId, workspaceId), user_id: String(userId ?? 'guest'), workspace_id: workspaceId, deleted_at: now() || 1 })
          const store = tx.objectStore('previews'), request = store.getAll()
          request.onsuccess = () => request.result.filter(entry => owned(entry, userId, workspaceId)).forEach(entry => store.delete(entry.key))
          tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error || new Error('项目本机数据清理失败'))
        })
        return true
      } catch (failure) {
        failure.deletionPersisted = journalPersisted
        throw failure
      }
    },
    async copyPreviews(userId, sourceId, targetId, sampleIds = null) {
      if (sourceId === targetId) throw domainError('invalid_project_copy', '副本需要独立的项目标识')
      if (deletionJournal.has(userId, sourceId) || deletionJournal.has(userId, targetId)) throw domainError('project_deleted', '此调色项目已删除，不能复制预览')
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['drafts', 'previews'], 'readwrite')
        const drafts = tx.objectStore('drafts'), previews = tx.objectStore('previews')
        const source = drafts.get(keyFor(userId, sourceId)), target = drafts.get(keyFor(userId, targetId)), request = previews.getAll()
        let failure, count = 0
        request.onsuccess = () => {
          if (source.result?.deleted_at || target.result?.deleted_at || deletionJournal.has(userId, sourceId) || deletionJournal.has(userId, targetId)) {
            failure = domainError('project_deleted', '此调色项目已删除，不能复制预览'); tx.abort(); return
          }
          const entries = request.result.filter(entry => owned(entry, userId, sourceId) && entry.expires_at > now() && (!sampleIds || sampleIds.includes(entry.sample_id)))
          const copiedIds = new Set(entries.map(entry => entry.sample_id))
          const total = [...entries, ...request.result.filter(entry => owned(entry, userId, targetId) && entry.expires_at > now() && !copiedIds.has(entry.sample_id))]
            .reduce((sum, entry) => sum + entry.blob.size, 0)
          if (total > PREVIEW_BUDGET_BYTES) { failure = domainError('preview_capacity', '本调色项目的预览缓存超过 24MB'); tx.abort(); return }
          for (const entry of entries) previews.put({ ...entry, key: keyFor(userId, `${targetId}:${entry.sample_id}`), workspace_id: targetId })
          count = entries.length
        }
        tx.oncomplete = () => resolve(count); tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('项目预览复制失败'))
      })
    },
    async save(userId, record, expectedRevision = 0) {
      if (deletionJournal.has(userId, record.workspace.id)) throw domainError('project_deleted', '此调色项目已删除，不能重新保存')
      if (record.workspace.user_id !== String(userId ?? 'guest')) throw domainError('invalid_owner', '不能保存其他账号的草稿')
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite')
        const store = tx.objectStore('drafts')
        const key = keyFor(userId, record.workspace.id)
        const request = store.get(key)
        let result; let failure
        request.onsuccess = () => {
          if (request.result?.deleted_at || deletionJournal.has(userId, record.workspace.id)) { failure = domainError('project_deleted', '此调色项目已删除，不能重新保存'); tx.abort(); return }
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
      if (deletionJournal.has(userId, workspaceId)) throw domainError('project_deleted', '此调色项目已删除，不能缓存预览')
      if (!(blob instanceof Blob)) throw domainError('invalid_preview', '样张缓存必须是缩小预览文件')
      if (blob.size > PREVIEW_BUDGET_BYTES) throw domainError('preview_capacity', '本调色项目的预览缓存超过 24MB')
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['drafts', 'previews'], 'readwrite')
        const deletedRequest = tx.objectStore('drafts').get(keyFor(userId, workspaceId))
        const store = tx.objectStore('previews')
        const request = store.getAll()
        let failure; let result
        request.onsuccess = () => {
          if (deletedRequest.result?.deleted_at || deletionJournal.has(userId, workspaceId)) { failure = domainError('project_deleted', '此调色项目已删除，不能缓存预览'); tx.abort(); return }
          const key = keyFor(userId, `${workspaceId}:${sampleId}`)
          const entries = request.result
          for (const entry of entries) if (entry.expires_at <= now()) store.delete(entry.key)
          const size = entries.filter((entry) => owned(entry, userId, workspaceId) && entry.expires_at > now() && entry.key !== key)
            .reduce((sum, entry) => sum + entry.blob.size, blob.size)
          if (size > PREVIEW_BUDGET_BYTES) { failure = domainError('preview_capacity', '本调色项目的预览缓存超过 24MB'); tx.abort(); return }
          result = { key, user_id: String(userId ?? 'guest'), workspace_id: workspaceId, sample_id: sampleId,
            blob, metadata, created_at: now(), expires_at: now() + PREVIEW_TTL_MS }
          store.put(result)
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(failure || tx.error || new Error('样张预览保存失败'))
        tx.onabort = () => reject(failure || tx.error || new Error('样张预览保存被中止'))
      })
    },
    async hasPreviews(userId, workspaceId) {
      return (await read('previews', store => store.getAll())).some(entry => owned(entry, userId, workspaceId) && entry.expires_at > now())
    },
    async getPreview(userId, workspaceId, sampleId) {
      const entry = await read('previews', (store) => store.get(keyFor(userId, `${workspaceId}:${sampleId}`)))
      return !deletionJournal.has(userId, workspaceId) && entry && entry.expires_at > now() ? entry : null
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
export function createMemoryDraftStorage({ now = () => Date.now(), deletionJournal = createProjectDeletionJournal({ localStorage: null }) } = {}) {
  const drafts = new Map(); const previews = new Map(); const retired = new Set()
  const isDeleted = (userId, id) => retired.has(keyFor(userId, id)) || deletionJournal.has(userId, id)
  const storage = {
    async load(userId, id) { return isDeleted(userId, id) ? null : structuredClone(drafts.get(keyFor(userId, id)) || null) },
    async list(userId) {
      return [...drafts.values()].filter((record) => record.workspace.user_id === String(userId ?? 'guest') && !isDeleted(userId, record.workspace.id))
        .map((record) => structuredClone(record)).sort((a, b) => b.workspace.updated_at - a.workspace.updated_at)
    },
    async latest(userId, sessionId) { return (await storage.list(userId)).find((record) => sessionId == null || record.workspace.session_id === sessionId) || null },
    async isDeleted(userId, id) { return isDeleted(userId, id) },
    async deletedIds(userId) {
      const prefix = String(userId ?? 'guest')
      return [...new Set([...deletionJournal.ids(userId), ...[...retired].flatMap(key => { const [owner, id] = JSON.parse(key); return owner === prefix ? [id] : [] })])]
    },
    async retire(userId, id) {
      deletionJournal.mark(userId, id); retired.add(keyFor(userId, id)); drafts.delete(keyFor(userId, id))
      await storage.clearPreviews(userId, id)
      return true
    },
    async save(userId, record, expectedRevision = 0) {
      if (isDeleted(userId, record.workspace.id)) throw domainError('project_deleted', '此调色项目已删除，不能重新保存')
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
      if (isDeleted(userId, workspaceId)) throw domainError('project_deleted', '此调色项目已删除，不能缓存预览')
      if (!(blob instanceof Blob)) throw domainError('invalid_preview', '样张缓存必须是缩小预览文件')
      const key = keyFor(userId, `${workspaceId}:${sampleId}`)
      for (const [entryKey, entry] of previews) if (entry.expires_at <= now()) previews.delete(entryKey)
      const size = [...previews.values()].filter((entry) => owned(entry, userId, workspaceId) && entry.key !== key)
        .reduce((sum, entry) => sum + entry.blob.size, blob.size)
      if (size > PREVIEW_BUDGET_BYTES) throw domainError('preview_capacity', '本调色项目的预览缓存超过 24MB')
      const entry = { key, user_id: String(userId ?? 'guest'), workspace_id: workspaceId, sample_id: sampleId,
        blob, metadata: structuredClone(metadata), created_at: now(), expires_at: now() + PREVIEW_TTL_MS }
      previews.set(key, entry); return structuredClone(entry)
    },
    async copyPreviews(userId, sourceId, targetId, sampleIds = null) {
      if (sourceId === targetId) throw domainError('invalid_project_copy', '副本需要独立的项目标识')
      if (isDeleted(userId, sourceId) || isDeleted(userId, targetId)) throw domainError('project_deleted', '此调色项目已删除，不能复制预览')
      const entries = [...previews.values()].filter(entry => owned(entry, userId, sourceId) && entry.expires_at > now() && (!sampleIds || sampleIds.includes(entry.sample_id)))
      const copiedIds = new Set(entries.map(entry => entry.sample_id))
      const total = [...entries, ...[...previews.values()].filter(entry => owned(entry, userId, targetId) && entry.expires_at > now() && !copiedIds.has(entry.sample_id))]
        .reduce((sum, entry) => sum + entry.blob.size, 0)
      if (total > PREVIEW_BUDGET_BYTES) throw domainError('preview_capacity', '本调色项目的预览缓存超过 24MB')
      for (const entry of entries) {
        const key = keyFor(userId, `${targetId}:${entry.sample_id}`)
        previews.set(key, structuredClone({ ...entry, key, workspace_id: targetId }))
      }
      return entries.length
    },
    async hasPreviews(userId, workspaceId) {
      return [...previews.values()].some(entry => owned(entry, userId, workspaceId) && entry.expires_at > now())
    },
    async getPreview(userId, workspaceId, sampleId) {
      const entry = previews.get(keyFor(userId, `${workspaceId}:${sampleId}`))
      return !isDeleted(userId, workspaceId) && entry && entry.expires_at > now() ? structuredClone(entry) : null
    },
    async clearPreviews(userId, workspaceId) { for (const [key, entry] of previews) if (owned(entry, userId, workspaceId)) previews.delete(key) },
  }
  return storage
}

export function draftBackup(record) {
  return JSON.stringify({ ...record, exported_at: new Date().toISOString() }, null, 2)
}
