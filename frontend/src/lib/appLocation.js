import { isCreationStep } from './creationFlow.js'

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function parseLocation(hash = '') {
  if (hash === '#/library') return { view: 'library', projectId: null, step: null }
  const [path, query = ''] = hash.replace(/^#/, '').split('?')
  if (path !== '/create') return { view: 'landing', projectId: null, step: null }
  const params = new URLSearchParams(query), id = params.get('project'), step = params.get('step')
  return { view: 'generate', projectId: PROJECT_ID.test(id || '') ? id.toLowerCase() : null,
    step: isCreationStep(step) ? step : null, invalidProject: Boolean(id && !PROJECT_ID.test(id)) }
}
export function locationHash({ view, projectId, step }) {
  if (view === 'library') return '#/library'
  if (view !== 'generate') return '#/'
  const query = new URLSearchParams()
  if (PROJECT_ID.test(projectId || '')) query.set('project', projectId.toLowerCase())
  if (isCreationStep(step)) query.set('step', step)
  return `#/create${query.size ? `?${query}` : ''}`
}

export async function resolveProjectLocation(id, { user, listLocal, listRemote, deletedIds }) {
  const [local, remote, deleted] = await Promise.allSettled([listLocal(), listRemote(), deletedIds()])
  if (deleted.status !== 'fulfilled' || local.status !== 'fulfilled' || !local.value)
    throw new Error('无法读取本机项目，请重试打开项目。')
  if (deleted.value.includes(id)) return null
  const draft = local.value.find(project => project.id === id && project.user_id === String(user))
  if (draft) return { ...draft, localOnly: true }
  if (remote.status !== 'fulfilled') throw remote.reason
  return remote.value.find(project => project.id === id) || null
}

// History represents viewing intent only. It never grants project ownership.
export function createLocationStore(browser = window) {
  let serial = 0
  let current = { ...parseLocation(browser.location.hash), serial, external: true }
  let lastHash = browser.location.hash
  const listeners = new Set()
  const publish = () => listeners.forEach(listener => listener(current))
  const changed = () => {
    if (lastHash === browser.location.hash) return
    lastHash = browser.location.hash
    current = { ...parseLocation(lastHash), serial: ++serial, external: true }
    publish()
  }
  return {
    get: () => current,
    subscribe(listener) {
      if (!listeners.size) { browser.addEventListener('popstate', changed); browser.addEventListener('hashchange', changed) }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { browser.removeEventListener('popstate', changed); browser.removeEventListener('hashchange', changed) }
      }
    },
    navigate(route, { replace = false } = {}) {
      const hash = locationHash(route)
      if (hash === lastHash && current.external === false) return
      if (hash !== lastHash) browser.history[replace ? 'replaceState' : 'pushState'](null, '', hash)
      lastHash = hash
      current = { ...parseLocation(hash), serial: ++serial, external: false }
      publish()
    },
  }
}
