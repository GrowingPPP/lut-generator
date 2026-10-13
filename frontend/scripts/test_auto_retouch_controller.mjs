import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryAutoJobStorage } from '../src/lib/autoJobStorage.js'
import { defaultParams } from '../src/lib/lutEngine.js'

const require = createRequire(import.meta.url)
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/hooks/useAutoRetouchController.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'auto-job-api-stub', setup(builder) {
    builder.onResolve({ filter: /lib\/api\.js$/ }, () => ({ path: 'api', namespace: 'auto-job-api-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'auto-job-api-stub' }, () => ({ contents: `
      export const startAutoJob = (...args) => __autoJobApi.start(...args);
      export const getAutoJob = (...args) => __autoJobApi.get(...args);
      export const cancelAutoJob = (...args) => __autoJobApi.cancel(...args);
    ` }))
  } }] })

const settle = () => new Promise(resolve => setImmediate(resolve))
const projectId = '00000000-0000-4000-8000-000000000001'
const otherProjectId = '00000000-0000-4000-8000-000000000002'
const context = { goal_mode: 'preserve', locked_fields: [] }
const sourceDigest = 'a'.repeat(64)
function deferred() {
  let resolve
  const promise = new Promise(settle => { resolve = settle })
  return { promise, resolve }
}
function completed(args, overrides = {}) {
  return { id: args.request_id, workspace_id: args.workspace_id, status: 'succeeded', persisted: true,
    result: { job_id: args.request_id, workspace_id: args.workspace_id, source_digest: args.source_digest,
      main_sample_id: args.main_sample_id, before_params: args.params, params: { ...args.params, contrast: .1 },
      context: args.context, goal_status: 'met' }, ...overrides }
}

// Run persistent React state/effects with deferred API results. Only the service
// boundary is stubbed; frozen requests, source checks and receipts remain real.
function controllerHost(api, overrides = {}) {
  const slots = [], cleanups = [], effects = []
  let cursor = 0, pending = []
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      if (!effects[index] || dependencies.some((value, offset) => value !== effects[index][offset])) {
        effects[index] = dependencies
        pending.push(() => { cleanups[index]?.(); cleanups[index] = callback() })
      }
    },
  }
  // Imported functions have no receiver, matching React's hook exports.
  hooks.useRef = initial => hooks.useState(() => ({ current: initial }))[0]
  const module = { exports: {} }
  new Function('require', 'module', 'exports', '__autoJobApi', bundle.outputFiles[0].text)(
    name => name === 'react' ? hooks : require(name), module, module.exports, api)
  const events = { busy: [], status: [], applied: [], restored: [] }
  let props = { file: {}, params: defaultParams(), context, workspaceId: projectId,
    sourceDigest, mainSampleId: 'primary', userId: '42', hasRealPhoto: true, workspaceReady: true,
    disabled: false, running: false, jobStorage: createMemoryAutoJobStorage(),
    setRunning: value => { props.running = value; events.busy.push(value) },
    setStatus: value => events.status.push(value),
    onResult: (result, request, meta) => { events.applied.push({ result, request, meta }); return true },
    onRestoreResult: (result, meta) => { events.restored.push({ result, meta }); return true }, ...overrides }
  return {
    events,
    get props() { return props },
    render(next = {}) {
      props = { ...props, ...next }; cursor = 0; pending = []
      const controller = module.exports.default(props)
      for (const run of pending) run()
      return controller
    },
    unmount() { cleanups.forEach(cleanup => cleanup?.()) },
  }
}

test('a persisted controller continues and applies once while step controls are absent', async () => {
  const gate = deferred(), requests = []
  const host = controllerHost({
    start: async args => { requests.push(args); return { id: args.request_id, status: 'running' } },
    get: () => gate.promise,
  })
  host.render(); await settle()
  let controller = host.render()
  controller.setStyle('保留暖色高光'); controller.setUseVision(false)
  controller = host.render()
  const pending = controller.run()
  await settle()
  assert.equal(host.props.running, true)
  // The parent still hosts the controller in another step, without rendering its bar.
  controller = host.render()
  assert.equal(controller.style, '保留暖色高光')
  assert.equal(controller.useVision, false)
  assert.equal(controller.canRun, false)
  gate.resolve(completed(requests[0])); await pending
  controller = host.render()
  assert.equal(host.events.applied.length, 1)
  assert.equal(host.events.restored.length, 0)
  assert.equal(host.props.running, false)
  assert.equal(requests.length, 1)
  assert.equal((await host.props.jobStorage.load('42', projectId)).state, 'applied')
  assert.equal(controller.job.status, 'succeeded')
  host.unmount()
})

test('refresh restores an accepted result without a File and does not apply it again', async () => {
  const storage = createMemoryAutoJobStorage()
  const args = { request_id: crypto.randomUUID(), workspace_id: projectId, params: defaultParams(),
    context, source_digest: sourceDigest, main_sample_id: 'primary', style: '保留氛围', useVision: false }
  await storage.begin('42', args)
  let queries = 0
  const host = controllerHost({ get: async () => { queries++; return completed(args) } },
    { file: null, hasRealPhoto: false, jobStorage: storage })
  host.render(); await settle()
  assert.equal(host.render().recoveryChecked, true)
  assert.equal(host.events.restored.length, 1)
  assert.equal(host.events.applied.length, 0)
  assert.equal(host.render().canRun, false)
  host.unmount()
  const second = controllerHost({ get: async () => { queries++; return completed(args) } },
    { file: null, hasRealPhoto: false, jobStorage: storage })
  second.render(); await settle()
  assert.equal(second.events.restored.length, 0)
  assert.equal(queries, 1)
  assert.equal(second.render().job.status, 'succeeded')
  second.unmount()
})

test('project, account and not-ready changes reject a late result and release old busy state', async () => {
  for (const next of [{ workspaceId: otherProjectId }, { userId: '43' }, { workspaceReady: false }]) {
    const gate = deferred(), requests = []
    const host = controllerHost({ start: async args => { requests.push(args); return { id: args.request_id, status: 'running' } },
      get: () => gate.promise })
    host.render(); await settle()
    const pending = host.render().run(); await settle()
    assert.equal(host.props.running, true)
    host.render(next); await settle()
    assert.equal(host.props.running, false)
    gate.resolve(completed(requests[0])); await pending
    assert.equal(host.events.applied.length, 0)
    assert.equal(host.events.restored.length, 0)
    assert.equal(host.render().job, null)
    if (next.workspaceReady === false) assert.equal(host.render().canRun, false)
    assert.equal((await host.props.jobStorage.load('42', projectId)).state, 'accepted')
    host.unmount()
  }
})

test('controller unmount releases busy state without applying a late result or cancelling the server job', async () => {
  const gate = deferred(), requests = [], cancellations = []
  const host = controllerHost({ start: async args => { requests.push(args); return { id: args.request_id, status: 'running' } },
    get: () => gate.promise, cancel: (...args) => cancellations.push(args) })
  host.render(); await settle()
  const pending = host.render().run(); await settle()
  host.unmount()
  assert.equal(host.props.running, false)
  gate.resolve(completed(requests[0])); await pending
  assert.equal(host.events.applied.length, 0)
  assert.equal(cancellations.length, 0)
  assert.equal((await host.props.jobStorage.load('42', projectId)).state, 'accepted')
})

test('delayed final receipt writes cannot restore old progress after project, owner or readiness changes', async () => {
  const identities = [{ workspaceId: otherProjectId }, { userId: '43' }, { workspaceReady: false }]
  const outcomes = ['applied', 'already-applied', 'source-conflict', 'not-applied', 'cancelled']
  for (const next of identities) for (const outcome of outcomes) {
    const service = deferred(), write = deferred(), writeStarted = deferred(), requests = []
    const storage = createMemoryAutoJobStorage()
    const update = storage.update.bind(storage)
    storage.update = async (...args) => {
      if (['applied', 'conflict', 'resolved'].includes(args[3].state)) {
        writeStarted.resolve()
        await write.promise
      }
      return update(...args)
    }
    const host = controllerHost({ start: args => { requests.push(args); return service.promise } }, {
      jobStorage: storage,
      getAppliedJob: () => outcome === 'already-applied',
      ...(outcome === 'not-applied' ? { onResult: () => false } : {}),
    })
    host.render(); await settle()
    const pending = host.render().run(); await settle()
    if (outcome === 'source-conflict') host.render({ mainSampleId: 'changed-primary' })
    const terminal = completed(requests[0], outcome === 'cancelled'
      ? { status: 'cancelled', persisted: false, result: null }
      : { continuation_stages: ['review'] })
    if (terminal.result) terminal.result.goal_status = 'partially_met'
    service.resolve(terminal)
    await writeStarted.promise
    host.render(next); await settle()
    const statusCount = host.events.status.length
    write.resolve(); await pending
    const controller = host.render()
    assert.equal(controller.continuable, null, outcome)
    assert.equal(controller.job, null, outcome)
    assert.equal(host.events.status.length, statusCount, `${outcome} published old status after switching`)
    assert.equal(host.props.running, false, outcome)
    assert.equal(await storage.load('42', otherProjectId), null)
    host.unmount()
  }
})

test('a changed primary-photo or protected context conflicts with the original result instead of applying it', async () => {
  for (const next of [{ mainSampleId: 'other-primary' }, { context: { ...context, locked_fields: ['contrast'] } }]) {
    const gate = deferred(), requests = []
    const host = controllerHost({ start: async args => { requests.push(args); return { id: args.request_id, status: 'running' } },
      get: () => gate.promise })
    host.render(); await settle()
    const pending = host.render().run(); await settle()
    host.render(next)
    gate.resolve(completed(requests[0])); await pending
    assert.equal(host.events.applied.length, 0)
    assert.equal(host.props.running, false)
    assert.equal((await host.props.jobStorage.load('42', projectId)).state, 'conflict')
    assert.match(host.events.status.at(-1), /来源已变化/)
    host.unmount()
  }
})

test('retry preserves the failed frozen request and is unavailable after parameters change', async () => {
  const requests = []
  const host = controllerHost({ start: async args => {
    requests.push(args)
    return requests.length === 1
      ? { id: args.request_id, workspace_id: projectId, status: 'failed', error: { message: 'model unavailable' } }
      : completed(args)
  } })
  host.render(); await settle()
  let controller = host.render()
  controller.setStyle('保留暖色'); controller.setUseVision(false)
  await host.render().run()
  controller = host.render()
  assert.equal(controller.canRetry, true)
  const failure = controller.failedRequest
  assert.equal(host.render({ params: { ...host.props.params, contrast: .2 } }).canRetry, false)
  assert.equal(host.render({ params: failure.args.params }).canRetry, true)
  controller = host.render()
  controller.setStyle('后来输入的其他要求'); controller.setUseVision(true)
  await host.render().run(failure)
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0].request_id, requests[1].request_id)
  assert.equal(requests[1].style, '保留暖色')
  assert.equal(requests[1].useVision, false)
  assert.deepEqual(requests[1].params, requests[0].params)
  assert.equal(host.events.applied.length, 1)
  host.unmount()
})

test('cancelling subject preparation never submits a grading job and waits for preparation to return', async () => {
  const gate = deferred(), requests = []
  const host = controllerHost({ start: args => { requests.push(args) } }, { onPrepare: () => gate.promise })
  host.render(); await settle()
  const pending = host.render().run(); await settle()
  let controller = host.render()
  assert.equal(controller.preparing, true)
  await controller.cancel()
  assert.equal(host.props.running, true)
  gate.resolve({ file: host.props.file, params: host.props.params, context,
    workspace_id: projectId, source_digest: sourceDigest, main_sample_id: 'primary' })
  await pending
  controller = host.render()
  assert.equal(host.props.running, false)
  assert.equal(controller.preparing, false)
  assert.equal(controller.cancelling, false)
  assert.equal(requests.length, 0)
})

test('storage failure during recovery keeps editing frozen and does not submit', async () => {
  let requests = 0
  const host = controllerHost({ start: () => { requests++ } },
    { jobStorage: { load: async () => { throw new Error('storage unavailable') } } })
  host.render(); await settle()
  const controller = host.render()
  assert.equal(controller.recoveryChecked, true)
  assert.equal(controller.canRun, false)
  assert.equal(host.props.running, true)
  assert.match(host.events.status.at(-1), /编辑保持冻结/)
  assert.equal(requests, 0)
  host.unmount()
})

test('controlled bar renders existing state without mounting a second controller', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/components/AutoRetouchBar.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    loader: { '.css': 'empty' },
    plugins: [{ name: 'controller-must-stay-in-parent', setup(builder) {
      builder.onResolve({ filter: /useAutoRetouchController\.js$/ }, () => ({ path: 'hook', namespace: 'controller-must-stay-in-parent' }))
      builder.onLoad({ filter: /.*/, namespace: 'controller-must-stay-in-parent' }, () => ({
        contents: 'export default function unexpectedController() { throw new Error("a second controller was mounted") }',
      }))
    } }] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  const controller = { style: '保留氛围', useVision: false, steps: [], canRun: true }
  const html = renderToStaticMarkup(React.createElement(module.exports.default, {
    controller, context, running: false, hasRealPhoto: true, sampleName: 'Public.jpg',
  }))
  assert.match(html, /保留氛围/)
  assert.match(html, /Public.jpg/)
  assert.match(html, /分析并应用/)
})
