import { validateParams, domainError } from './styleRecipe.js'
import { contextSignature } from './workspaceFlow.js'

const DB_NAME = 'chroma-auto-job-receipts'
const keyFor = (userId, workspaceId) => JSON.stringify([String(userId), workspaceId])
const STATES = new Set(['submitting', 'accepted', 'terminal', 'applied', 'resolved', 'conflict', 'rejected'])
const ACTIVE = new Set(['submitting', 'accepted'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function jsonOnly(value) {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(jsonOnly)
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOnly(item)]))
  throw domainError('invalid_job_receipt', '作业记录只允许 JSON 摘要，不得包含照片或二进制文件')
}

function jobSummary(job, receipt) {
  if (job.id !== receipt.request_id || job.workspace_id !== receipt.workspace_id)
    throw domainError('invalid_job_receipt', '作业结果的标识或工作区不一致')
  const keys = ['id', 'status', 'persisted', 'result', 'can_cancel', 'workspace_id', 'source_digest',
    'main_sample_id', 'stages', 'progress', 'continuation_stages', 'continued_from', 'error',
    'not_accepted', 'recovered_from_report', 'created_at', 'updated_at', 'expires_at']
  return jsonOnly(Object.fromEntries(keys.filter(key => Object.hasOwn(job, key)).map(key => [key, job[key]])))
}

export function autoJobReceipt(args, userId, now = Date.now()) {
  validateParams(args.params)
  const context = args.context || { goal_mode: 'natural', locked_fields: [] }
  if (!contextSignature(context))
    throw domainError('invalid_context', '作业上下文不正确')
  if (!UUID.test(args.request_id || '') || !UUID.test(args.workspace_id || '') || !userId || userId === 'guest')
    throw domainError('invalid_job_receipt', '作业需要有效账号和工作区标识')
  if (typeof args.source_digest !== 'string' || !/^[a-f0-9]{64}$/i.test(args.source_digest)
      || typeof args.main_sample_id !== 'string' || !args.main_sample_id)
    throw domainError('invalid_job_receipt', '作业需要有效的主样张来源')
  const request = { request_id: args.request_id, workspace_id: args.workspace_id,
    source_digest: args.source_digest, main_sample_id: args.main_sample_id,
    params: structuredClone(args.params), context: structuredClone(context),
    style: typeof args.style === 'string' ? args.style.slice(0, 200) : '',
    useVision: args.useVision !== false, maxRounds: args.maxRounds ?? 2,
    sample_origin: 'source', ...(args.continue_from ? { continue_from: args.continue_from } : {}) }
  return { format_version: 1, user_id: String(userId), workspace_id: args.workspace_id,
    request_id: args.request_id, request, state: 'submitting', applied: false,
    created_at: now, updated_at: now, cancel_requested: false }
}

export function validateAutoJobReceipt(receipt, userId, workspaceId) {
  if (!receipt || receipt.format_version !== 1 || receipt.user_id !== String(userId)
      || receipt.workspace_id !== workspaceId || !STATES.has(receipt.state))
    throw domainError('invalid_job_receipt', '本机作业记录的格式或归属不正确')
  const clean = autoJobReceipt(receipt.request, userId, receipt.created_at)
  if (clean.request_id !== receipt.request_id || clean.workspace_id !== receipt.workspace_id)
    throw domainError('invalid_job_receipt', '本机作业标识不一致')
  return { ...clean, state: receipt.state, applied: receipt.applied === true,
    cancel_requested: receipt.cancel_requested === true, updated_at: receipt.updated_at,
    ...(receipt.job ? { job: jobSummary(receipt.job, receipt) } : {}),
    ...(receipt.message ? { message: String(receipt.message).slice(0, 1000) } : {}) }
}

function patchReceipt(receipt, patch, now) {
  const allowed = ['state', 'applied', 'cancel_requested', 'job', 'message']
  return { ...receipt, ...Object.fromEntries(allowed.filter(key => key in patch)
    .map(key => [key, structuredClone(patch[key])])), updated_at: now }
}

function checkBegin(current, incoming) {
  if (current && ACTIVE.has(current.state) && current.request_id !== incoming.request_id)
    throw domainError('job_receipt_conflict', '此工作区还有未确认结束的作业，请先恢复或确认结束')
  if (current?.request_id === incoming.request_id && JSON.stringify(current.request) !== JSON.stringify(incoming.request))
    throw domainError('job_receipt_conflict', '同一作业标识不能改写冻结请求')
}

export function createAutoJobStorage({ indexedDB = globalThis.indexedDB, now = () => Date.now() } = {}) {
  let database
  const getDb = () => database || (database = new Promise((resolve, reject) => {
    if (!indexedDB) { reject(domainError('storage_unavailable', '无法保存作业恢复记录，本次请求未提交')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('receipts', { keyPath: 'key' })
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error || new Error('作业记录打开失败'))
    request.onblocked = () => reject(domainError('storage_blocked', '作业记录被其他标签页占用'))
  }).catch(error => { database = null; throw error }))

  async function transact(userId, workspaceId, update) {
    const db = await getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', update ? 'readwrite' : 'readonly')
      const store = tx.objectStore('receipts'), key = keyFor(userId, workspaceId)
      const request = store.get(key)
      let result = null, failure
      request.onsuccess = () => {
        try {
          const current = request.result ? validateAutoJobReceipt(request.result.receipt, userId, workspaceId) : null
          result = update ? update(current) : current
          if (update && result) store.put({ key, receipt: validateAutoJobReceipt(result, userId, workspaceId) })
        } catch (error) { failure = error; tx.abort() }
      }
      request.onerror = () => { failure = request.error }
      tx.oncomplete = () => resolve(structuredClone(result))
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('作业记录保存失败'))
    })
  }
  return {
    load: (userId, workspaceId) => transact(userId, workspaceId),
    begin: (userId, args) => transact(userId, args.workspace_id, current => {
      const incoming = autoJobReceipt(args, userId, now())
      checkBegin(current, incoming)
      return current?.request_id === incoming.request_id ? current : incoming
    }),
    update: (userId, workspaceId, requestId, patch) => transact(userId, workspaceId, current => {
      if (!current || current.request_id !== requestId) throw domainError('job_receipt_conflict', '作业记录已变化，不能覆盖新请求')
      return patchReceipt(current, patch, now())
    }),
  }
}

export function createMemoryAutoJobStorage({ now = () => Date.now() } = {}) {
  const records = new Map()
  return {
    async load(userId, workspaceId) {
      const current = records.get(keyFor(userId, workspaceId))
      return current ? validateAutoJobReceipt(current, userId, workspaceId) : null
    },
    async begin(userId, args) {
      const key = keyFor(userId, args.workspace_id), current = records.get(key)
      const incoming = autoJobReceipt(args, userId, now())
      checkBegin(current, incoming)
      const result = current?.request_id === incoming.request_id ? current : incoming
      records.set(key, structuredClone(result))
      return structuredClone(result)
    },
    async update(userId, workspaceId, requestId, patch) {
      const key = keyFor(userId, workspaceId), current = records.get(key)
      if (!current || current.request_id !== requestId) throw domainError('job_receipt_conflict', '作业记录已变化，不能覆盖新请求')
      const result = validateAutoJobReceipt(patchReceipt(current, patch, now()), userId, workspaceId)
      records.set(key, result)
      return structuredClone(result)
    },
  }
}
