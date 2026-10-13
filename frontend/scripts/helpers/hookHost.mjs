import { createRequire } from 'node:module'
import * as React from 'react'
const require = createRequire(import.meta.url)
export function hookHost(code, globals = {}) {
  const slots = []
  let cursor = 0, dirty = false, pending = [], props, value
  const changed = (before, after) => !before || after.some((item, index) => !Object.is(item, before[index]))
  const hooks = { ...React,
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      slot.update ||= update => { const next = typeof update === 'function' ? update(slot.value) : update
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true } }
      return [slot.value, slot.update]
    },
    useMemo(factory, dependencies) { const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) slots[index] = { value: factory(), dependencies }
      return slots[index].value },
    useEffect(effect, dependencies) { const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) { const prior = slots[index]; slots[index] = { dependencies }
        pending.push(() => { prior?.cleanup?.(); slots[index].cleanup = effect() }) } },
  }
  hooks.useRef = initial => hooks.useState(() => ({ current: initial }))[0]
  hooks.useCallback = (callback, deps) => hooks.useMemo(() => callback, deps)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(name => name === 'react' ? hooks : require(name), module, module.exports, ...Object.values(globals))
  const render = next => { if (next !== undefined) props = next
    for (let turn = 0; turn < 20; turn++) { cursor = 0; dirty = false; pending = []; value = module.exports.default(props); pending.forEach(effect => effect()); if (!dirty) return value }
    throw new Error('hook render did not settle') }
  return { render, get value() { return value }, async settle() { for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); if (dirty) render() } }, unmount() { slots.forEach(slot => slot?.cleanup?.()) } }
}
