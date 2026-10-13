import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createNotice, describeError } from '../src/lib/notices.js'

const require = createRequire(import.meta.url)
async function compile(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' } })
  return result.outputFiles[0].text
}
const noticeCode = await compile('../src/components/ui/Notice.jsx')
const hookCode = await compile('../src/hooks/useOperationNotice.js')

// Execute the real hooks and effects with a deterministic clock. Rendering and
// service boundaries are separate so timing and stale callbacks are observable.
function host(code) {
  const slots = [], timers = new Map()
  let cursor = 0, dirty = false, pending = [], now = 0, timerId = 0, props, value
  const changed = (a, b) => !a || b.some((item, index) => !Object.is(item, a[index]))
  const hooks = { ...React,
    useState(initial) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      slot.update ||= update => {
        const next = typeof update === 'function' ? update(slot.value) : update
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true }
      }
      return [slot.value, slot.update]
    },
    useMemo(factory, dependencies) {
      const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) slots[index] = { value: factory(), dependencies }
      return slots[index].value
    },
    useEffect(effect, dependencies) {
      const index = cursor++
      if (changed(slots[index]?.dependencies, dependencies)) {
        const previous = slots[index]
        slots[index] = { dependencies }
        pending.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() })
      }
    },
  }
  hooks.useRef = initial => hooks.useState(() => ({ current: initial }))[0]
  hooks.useCallback = (callback, dependencies) => hooks.useMemo(() => callback, dependencies)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'Date', code)(
    name => name === 'react' ? hooks : require(name), module, module.exports,
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id },
    id => timers.delete(id), { now: () => now })
  const render = next => {
    if (next !== undefined) props = next
    for (let iteration = 0; iteration < 10; iteration++) {
      cursor = 0; pending = []; dirty = false
      value = module.exports.default(props)
      pending.forEach(effect => effect())
      if (!dirty) return value
    }
    throw new Error('render did not settle')
  }
  return { render, get value() { return value },
    advance(ms) {
      const end = now + ms
      while (true) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); now = due[1].at; due[1].callback()
      }
      now = end
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}

test('technical failures disclose only safe diagnostics and retain request identity', () => {
  const error = Object.assign(new Error("1 validation error: input_value='private-value' token=secret"),
    { status: 422, code: 'schema_mismatch', accepted: true })
  const notice = createNotice(error, 'error')
  assert.equal(notice.message, '请求数据未被服务接受，请检查输入条件后重试。')
  assert.match(notice.details, /HTTP 422.*schema_mismatch.*原作业状态/)
  assert.doesNotMatch(JSON.stringify(notice), /private-value|secret/)
  assert.equal(error.accepted, true)
  assert.equal(error.status, 422)
  assert.match(error.message, /private-value/)
  assert.match(describeError(new Error('Failed to fetch')).message, /连接服务/)
  assert.doesNotMatch(describeError('验证失败：[{"input":"private-value","type":"extra_forbidden"}]').message, /private-value/)
  assert.equal(describeError('此输入需使用 [STD] 基准').message, '此输入需使用 [STD] 基准')
})

test('leaving a project clears notices and late callbacks cannot replace the current notice', () => {
  const h = host(hookCode)
  const first = h.render('project-a')
  first.notify('已保存 A', 'success')
  const oldId = h.render().notice.id
  const second = h.render('project-b')
  assert.equal(second.notice, null)
  second.notify('请绑定照片', 'warning')
  first.notify('迟到的 A 失败', 'error')
  assert.equal(h.render().notice.message, '请绑定照片')
  first.dismiss(oldId)
  assert.equal(h.render().notice.message, '请绑定照片')
  assert.equal(h.render('project-a').notice, null)
  h.unmount()
})

test('success expiry pauses for hover or focus and resumes with the remaining duration', () => {
  const h = host(noticeCode), expired = []
  h.render({ notice: createNotice('已保存', 'success', 'p', 7), onDismiss: id => expired.push(id) })
  h.advance(1000)
  h.value.props.onPointerEnter(); h.render()
  h.advance(2000)
  h.value.props.onFocusCapture(); h.render()
  h.value.props.onPointerLeave(); h.render()
  h.advance(10000)
  assert.deepEqual(expired, [])
  h.value.props.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null }); h.render()
  h.advance(4999)
  assert.deepEqual(expired, [])
  h.advance(1)
  assert.deepEqual(expired, [7])
  h.unmount()
})

test('error recovery stays visible, is announced as an alert and has an explicit action', () => {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', noticeCode)(require, module, module.exports)
  const markup = renderToStaticMarkup(React.createElement(module.exports.ErrorNotice,
    { error: new Error('NetworkError'), onRetry() {}, retryLabel: '重新加载' }))
  assert.match(markup, /role="alert"/)
  assert.match(markup, /重新加载/)
  const h = host(noticeCode), expired = []
  h.render({ notice: createNotice('需要恢复', 'error', 'p', 8), onDismiss: id => expired.push(id) })
  h.advance(60000)
  assert.deepEqual(expired, [])
  h.unmount()
})
