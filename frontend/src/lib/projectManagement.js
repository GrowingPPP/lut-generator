import { clone, domainError } from './styleRecipe.js'
import { commitEdit, workspaceId } from './workspace.js'

const DELETION_PREFIX = 'chroma-deleted-project:v1:'
const deletionKey = (userId, id) => `${DELETION_PREFIX}${JSON.stringify([String(userId ?? 'guest'), id])}`

export function projectName(value) {
  if (typeof value !== 'string') throw domainError('invalid_project_name', '请输入调色项目名称')
  const name = value.trim()
  if (!name || [...name].length > 160 || /[\u0000-\u001f]/.test(name)) throw domainError('invalid_project_name', '项目名称须为 1–160 个字符，不能包含控制字符')
  return name
}

export function renameWorkspaceState(state, value) {
  const name = projectName(value)
  const next = clone(state)
  next.workspace.name = name
  next.workspace.updated_at = Date.now()
  // Project names are management metadata: later undo/redo must keep the name.
  for (const transaction of [...next.past, ...next.future]) {
    transaction.before.name = name
    transaction.after.name = name
  }
  if (next.pending) next.pending.before.name = name
  return next
}

export function duplicateProjectName(name) {
  return `${[...(name || '调色项目')].slice(0, 157).join('')} 副本`
}

export function duplicateWorkspaceState(state, { id = workspaceId(), sessionId = null, name } = {}) {
  if (id === state.workspace.id) throw domainError('invalid_project_copy', '副本需要独立的项目标识')
  const current = state.pending ? commitEdit(state) : state
  const workspace = clone(current.workspace)
  const stamp = Date.now()
  Object.assign(workspace, { id, session_id: sessionId, name: projectName(name ?? duplicateProjectName(workspace.name)),
    revision: 0, created_at: stamp, updated_at: stamp, associated_version: null,
    applied_auto_job_ids: [], report: null, validation: null })
  // Comparison versions belong to the source project and are not copied.
  if (workspace.view_state) {
    workspace.view_state.comparison = null
    workspace.view_state.comparison_mode = 'current'
  }
  return { workspace, past: [], future: [], pending: null }
}

function availableLocalStorage() {
  try { return globalThis.localStorage } catch { return null }
}

// A small independent deletion journal survives a failed IndexedDB cleanup. One
// key per project avoids lost updates when different tabs delete concurrently.
export function createProjectDeletionJournal({ localStorage = availableLocalStorage() } = {}) {
  const deleted = new Set()
  return {
    has(userId, id) {
      const key = deletionKey(userId, id)
      if (deleted.has(key)) return true
      try { return localStorage?.getItem(key) != null } catch { return false }
    },
    mark(userId, id) {
      const key = deletionKey(userId, id)
      deleted.add(key)
      try {
        if (!localStorage) return false
        localStorage.setItem(key, String(Date.now()))
        return true
      } catch { return false }
    },
    ids(userId) {
      const keys = new Set(deleted)
      try {
        for (let i = 0; i < (localStorage?.length || 0); i++) {
          const key = localStorage.key(i)
          if (key?.startsWith(DELETION_PREFIX)) keys.add(key)
        }
      } catch { /* The in-memory fence still protects this tab. */ }
      return [...keys].flatMap(key => {
        try {
          const [owner, id] = JSON.parse(key.slice(DELETION_PREFIX.length))
          return owner === String(userId ?? 'guest') && typeof id === 'string' ? [id] : []
        } catch { return [] }
      })
    },
  }
}

export async function retireLocalProject({ draftStorage, jobStorage, userId, id }) {
  // Both stores are attempted even if one fails. Draft retirement installs the
  // deletion fence before its first await; receipts keep their own tombstone.
  const results = await Promise.allSettled([
    Promise.resolve().then(() => draftStorage.retire(userId, id)),
    ...(jobStorage?.remove ? [Promise.resolve().then(() => jobStorage.remove(userId, id))] : []),
  ])
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) {
    const failure = domainError('project_cleanup_failed', '项目已删除，但部分本机数据未能清理，请重试清理')
    failure.cleanupFailures = failures
    throw failure
  }
  return true
}
