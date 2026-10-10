import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { captureAutoRequest, sameAutoConditions, jobProgressSteps, pollAutoJob, ensureAutoJob, continuationRequest, matchingAutoResult } from '../src/lib/autoJobs.js'

const request = () => ({ file: {}, params: defaultParams(), context: { goal_mode: 'preserve', locked_fields: ['gain'] }, workspace_id: 'w', source_digest: 'digest', main_sample_id: 's' })
test('captured request keeps immutable RGB/context snapshots and exact source conditions', () => {
  const current = request(), captured = captureAutoRequest(current)
  assert.equal(sameAutoConditions(captured, current), true)
  current.params.gain[0] = 1.1
  assert.equal(captured.params.gain[0], 1)
  assert.equal(sameAutoConditions(captured, current), false)
  for (const key of ['file', 'workspace_id', 'source_digest', 'main_sample_id']) {
    assert.equal(sameAutoConditions(captured, { ...captured, [key]: 'other' }), false)
  }
  assert.equal(sameAutoConditions(captured, { ...captured, context: { ...captured.context, goal_mode: 'natural' } }), false)
})
test('only actual stage states and reasons become progress text', () => {
  assert.deepEqual(jobProgressSteps({ stages: [{ stage: 'style', state: 'running', round: 2 }, { stage: 'optimize', state: 'skipped', reason: 'locked' }] }), [
    { key: 'style', title: '风格化', state: 'running', detail: '第 2 轮' },
    { key: 'optimize', title: '修正影调与色彩', state: 'skipped', detail: '可调字段已保护' },
  ])
})
test('cancelling is not terminal and polling waits for confirmed cancellation', async () => {
  const states = ['running', 'cancelling', 'cancelling', 'cancelled'], seen = []
  const result = await pollAutoJob('j', { get: async () => ({ id: 'j', status: states.shift() }), onProgress: job => seen.push(job.status), sleep: async () => {} })
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(seen, ['running', 'cancelling', 'cancelling', 'cancelled'])
})
test('connection failure keeps polling and a saved result may win cancellation', async () => {
  let calls = 0, errors = 0
  const result = await pollAutoJob('j', { get: async () => { if (++calls === 1) throw new Error('network'); return { id: 'j', status: 'succeeded', persisted: true } }, onConnectionError: () => errors++, sleep: async () => {} })
  assert.equal(result.status, 'succeeded')
  assert.equal(errors, 1)
})
test('lost jobs are reported as lost, never as cancelled', async () => {
  await assert.rejects(pollAutoJob('j', { get: async () => { throw Object.assign(new Error('missing'), { status: 404 }) } }), error => error.code === 'job_lost' && !error.message.includes('已取消'))
})
test('unmounted request never publishes late progress or result', async () => {
  let current = true, progress = 0
  const result = await pollAutoJob('j', { get: async () => { current = false; return { id: 'j', status: 'succeeded' } }, isCurrent: () => current, onProgress: () => progress++ })
  assert.equal(result, null)
  assert.equal(progress, 0)
})

test('lost submission response and an early 404 repeat the identical captured request', async () => {
  const captured = captureAutoRequest(request()), seen = []
  let starts = 0, errors = 0
  const job = await ensureAutoJob(captured, {
    start: async args => {
      seen.push(args)
      if (++starts === 1) throw new Error('response lost')
      return { id: args.request_id, status: 'queued' }
    },
    get: async () => { throw Object.assign(new Error('not registered yet'), { status: 404 }) },
    onConnectionError: () => errors++, sleep: async () => {},
  })
  assert.equal(job.id, captured.request_id)
  assert.deepEqual(seen, [captured, captured])
  assert.equal(errors, 1)
})

test('lost submission response recovers the accepted job without making another request', async () => {
  const captured = captureAutoRequest(request())
  let starts = 0
  const job = await ensureAutoJob(captured, {
    start: async () => { starts++; throw new Error('response lost') },
    get: async id => ({ id, status: 'running' }), sleep: async () => {},
  })
  assert.equal(starts, 1)
  assert.equal(job.status, 'running')
})

test('an explicit validation rejection is confirmed by checking that the same id was not accepted', async () => {
  const error = Object.assign(new Error('validation'), { status: 422 })
  let queries = 0
  await assert.rejects(ensureAutoJob(captureAutoRequest(request()), {
    start: async () => { throw error },
    get: async () => { queries++; throw Object.assign(new Error('absent'), { status: 404 }) },
  }), rejected => rejected === error && rejected.confirmedNotAccepted)
  assert.equal(queries, 1)
})

test('fingerprint conflict, expired receipt and definite unsupported deployment never recover an old result', async () => {
  for (const error of [Object.assign(new Error('conflict'), { status: 409 }),
    Object.assign(new Error('expired'), { status: 410 }),
    Object.assign(new Error('single worker'), { status: 503, code: 'single_worker_required', accepted: false })]) {
    let queries = 0
    await assert.rejects(ensureAutoJob(captureAutoRequest(request()), {
      start: async () => { throw error },
      get: async id => { queries++; return { id, status: 'succeeded', result: {} } },
    }), rejected => rejected === error && rejected.confirmedNotAccepted)
    assert.equal(queries, 0)
  }
})

test('continuation requires a formal partial result and starts a new request from its candidate', () => {
  const captured = captureAutoRequest(request())
  const completed = { id: captured.request_id, status: 'succeeded', persisted: true, continuation_stages: ['optimize'],
    result: { goal_status: 'partially_met', params: { ...captured.params, exposure: .1 } } }
  const next = continuationRequest(captured, completed)
  assert.notEqual(next.request_id, captured.request_id)
  assert.equal(next.continue_from, completed.id)
  assert.equal(next.params.exposure, .1)
  assert.equal(next.file, captured.file)
  completed.result.params.exposure = .2
  assert.equal(next.params.exposure, .1)
  for (const change of [{ status: 'failed' }, { persisted: false }, { continuation_stages: [] }, { result: { goal_status: 'met' } }])
    assert.equal(continuationRequest(captured, { ...completed, ...change }), null)
})

test('a final result must match captured source, context and before parameters before application', () => {
  const captured = captureAutoRequest(request())
  const result = { before_params: captured.params, context: captured.context,
    workspace_id: captured.workspace_id, source_digest: captured.source_digest, main_sample_id: captured.main_sample_id }
  const completed = { id: captured.request_id, result }
  assert.equal(matchingAutoResult(captured, completed), true)
  for (const key of ['workspace_id', 'source_digest', 'main_sample_id'])
    assert.equal(matchingAutoResult(captured, { ...completed, result: { ...result, [key]: 'other' } }), false)
  assert.equal(matchingAutoResult(captured, { ...completed, result: { ...result, before_params: { ...captured.params, exposure: .1 } } }), false)
  assert.equal(matchingAutoResult(captured, { ...completed, result: { ...result, context: { ...captured.context, locked_fields: [] } } }), false)
})

test('completed failed or blocked attempts are not described as applied parameters', () => {
  for (const reason of ['failed', 'blocked', 'unchanged']) {
    const [stage] = jobProgressSteps({ stages: [{ stage: 'style', state: 'done', reason }] })
    assert.match(stage.detail, reason === 'unchanged' ? /没有变化/ : /未应用/)
    assert.doesNotMatch(stage.detail, /参数已应用/)
  }
})
