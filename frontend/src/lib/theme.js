export const THEME_STORAGE_KEY = 'chroma-theme'
export const THEME_OPTIONS = Object.freeze([
  Object.freeze({ value: 'dark', label: '深色' }),
  Object.freeze({ value: 'gray', label: '中性灰' }),
  Object.freeze({ value: 'light', label: '浅色' }),
  Object.freeze({ value: 'system', label: '跟随系统' }),
])

export function normalizeThemePreference(value) {
  return THEME_OPTIONS.some(option => option.value === value) ? value : 'dark'
}

export function resolveTheme(preference, systemDark = true) {
  const valid = normalizeThemePreference(preference)
  return valid === 'system' ? (systemDark ? 'dark' : 'light') : valid
}

export function createThemeController({ window: host = globalThis.window, document: doc = host?.document } = {}) {
  let preference = 'dark'
  let systemDark = true
  let initialized = false
  let storage = null
  let media = null
  const listeners = new Set()

  function apply() {
    doc?.documentElement?.setAttribute('data-theme', resolveTheme(preference, systemDark))
    doc?.documentElement?.setAttribute('data-theme-preference', preference)
  }

  function update(value) {
    const next = normalizeThemePreference(value)
    const changed = next !== preference
    preference = next
    apply()
    if (changed) listeners.forEach(listener => listener())
  }

  function onStorage(event) {
    if ((event.key !== THEME_STORAGE_KEY && event.key !== null)
      || (event.storageArea && storage && event.storageArea !== storage)) return
    update(event.key === null ? null : event.newValue)
  }

  function onSystemChange(event) {
    systemDark = Boolean(event.matches)
    if (preference === 'system') apply()
  }

  function initialize() {
    if (initialized) return
    initialized = true
    try {
      storage = host?.localStorage || null
      preference = normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY))
    } catch {
      preference = 'dark'
    }
    try {
      media = host?.matchMedia?.('(prefers-color-scheme: dark)') || null
      systemDark = media ? Boolean(media.matches) : true
      if (media?.addEventListener) media.addEventListener('change', onSystemChange)
      else media?.addListener?.(onSystemChange)
    } catch {
      media = null
      systemDark = true
    }
    host?.addEventListener?.('storage', onStorage)
    apply()
  }

  return {
    initialize,
    getPreference() { initialize(); return preference },
    getResolvedTheme() { initialize(); return resolveTheme(preference, systemDark) },
    setPreference(value) {
      initialize()
      update(value)
      try { storage?.setItem(THEME_STORAGE_KEY, preference) } catch { /* 页面内偏好仍然有效。 */ }
    },
    subscribe(listener) {
      initialize()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      host?.removeEventListener?.('storage', onStorage)
      if (media?.removeEventListener) media.removeEventListener('change', onSystemChange)
      else media?.removeListener?.(onSystemChange)
      initialized = false
      listeners.clear()
    },
  }
}

let controller
function currentTheme() {
  controller ||= createThemeController()
  controller.initialize()
  return controller
}

export function initializeTheme() { currentTheme() }
export function getThemePreference() { return currentTheme().getPreference() }
export function setThemePreference(preference) { currentTheme().setPreference(preference) }
export function subscribeTheme(listener) { return currentTheme().subscribe(listener) }
