import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { createMemoryAutoJobStorage, autoJobReceipt, validateAutoJobReceipt } from '../src/lib/autoJobStorage.js'
import { captureAutoRequest, sameAutoMetadata, bindAutoRequest, waitRestoredAutoJob, matchingAutoResult } from '../src/lib/autoJobs.js'

const request = () => captureAutoRequest({ file: new Blob(['original photo']), params: defaultParams(),
  context: { goal_mode: 'preserve', locked_fields: ['gain'] }, workspace_id: crypto.randomUUID(),
  source_digest: 'a'.repeat(64), main_sample_id: 'main', style: '清透', useVision: false })

test('receipt contains the frozen JSON contract but neither file bytes nor arbitrary request fields', () => {
  const args = request()
  const receipt = autoJobReceipt({ ...args, secret: 'private', preview: new Blob(['pixels']) }, 1)
  assert.equal(receipt.request.file, undefined)
  assert.equal(receipt.request.preview, undefined)
  assert.equal(receipt.request.secret, undefined)
  assert.deepEqual(receipt.request.params, args.params)
  assert.deepEqual(receipt.request.context, args.context)
  assert.equal(receipt.request.source_digest, args.source_digest)
  args.params.gain[0] = 1.1
  assert.equal(receipt.request.params.gain[0], 1)
  assert.equal(JSON.stringify(receipt).includes('original photo'), false)
})

test('storage is account/workspace isolated and cannot overwrite an unresolved or newer request', async () => {
  const storage = createMemoryAutoJobStorage(), args = request()
  await storage.begin(1, args)
  assert.equal(await storage.load(2, args.workspace_id), null)
  assert.equal(await storage.load(1, crypto.randomUUID()), null)
  await assert.rejects(storage.begin(1, { ...args, request_id: crypto.randomUUID() }), error => error.code === 'job_receipt_conflict')
  await assert.rejects(storage.begin(1, { ...args, params: { ...args.params, contrast: .1 } }), error => error.code === 'job_receipt_conflict')
  await storage.update(1, args.workspace_id, args.request_id, { state: 'resolved' })
  const newer = { ...args, request_id: crypto.randomUUID() }
  await storage.begin(1, newer)
  await assert.rejects(storage.update(1, args.workspace_id, args.request_id, { state: 'applied' }), error => error.code === 'job_receipt_conflict')
  assert.equal((await storage.load(1, args.workspace_id)).request_id, newer.request_id)
})

test('terminal and applied receipts keep a result identity but reject binary payloads and foreign results', async () => {
  const storage = createMemoryAutoJobStorage(), args = request()
  await storage.begin(1, args)
  const job = { id: args.request_id, workspace_id: args.workspace_id, status: 'succeeded',
    persisted: true, result: { params: args.params, job_id: args.request_id } }
  await storage.update(1, args.workspace_id, args.request_id, { state: 'applied', applied: true, job })
  assert.equal((await storage.load(1, args.workspace_id)).applied, true)
  await assert.rejects(storage.update(1, args.workspace_id, args.request_id, { job: { ...job, result: { photo: args.file } } }), error => error.code === 'invalid_job_receipt')
  await assert.rejects(storage.update(1, args.workspace_id, args.request_id, { job: { ...job, workspace_id: crypto.randomUUID() } }), error => error.code === 'invalid_job_receipt')
  assert.equal((await storage.load(1, args.workspace_id)).job.result.job_id, args.request_id)
})

test('restored candidate matching does not require a File while retry binding does', () => {
  const args = request(), receipt = autoJobReceipt(args, 1)
  const current = { ...args, file: null }
  assert.equal(sameAutoMetadata(receipt.request, current), true)
  assert.equal(bindAutoRequest(receipt.request, current), null)
  const result = { params: args.params, before_params: args.params, context: args.context,
    workspace_id: args.workspace_id, source_digest: args.source_digest, main_sample_id: args.main_sample_id }
  assert.equal(matchingAutoResult(receipt.request, { id: args.request_id, result }), true)
  assert.ok(bindAutoRequest(receipt.request, { ...current, file: new Blob(['rebound']) }))
  for (const change of [{ source_digest: 'b'.repeat(64) }, { main_sample_id: 'other' },
    { params: { ...args.params, exposure: .1 } }, { context: { ...args.context, goal_mode: 'natural' } }]) {
    assert.equal(sameAutoMetadata(receipt.request, { ...current, ...change }), false)
    assert.equal(bindAutoRequest(receipt.request, { ...current, file: args.file, ...change }), null)
  }
})

test('an initial restored 404 keeps waiting until the original submission appears', async () => {
  let attempts = 0, missing = 0, sleeping = 0
  const job = await waitRestoredAutoJob('job', {
    get: async id => { if (++attempts === 1) throw Object.assign(new Error('not registered'), { status: 404 }); return { id, status: 'running' } },
    onMissing: () => missing++, sleep: async () => sleeping++,
  })
  assert.equal(job.status, 'running')
  assert.equal(missing, 1)
  assert.equal(sleeping, 1)
})

test('a missing restored submission is resolved only by an explicit confirmed fence result', async () => {
  let decision = null, queries = 0
  const job = await waitRestoredAutoJob('job', {
    get: async () => { queries++; throw Object.assign(new Error('missing'), { status: 404 }) },
    resolved: () => decision,
    sleep: async () => { decision = { id: 'job', status: 'cancelled', not_accepted: true } },
  })
  assert.equal(job.status, 'cancelled')
  assert.equal(job.not_accepted, true)
  assert.equal(queries, 1)
})

test('a late result after changing account or workspace never leaves recovery waiting', async () => {
  let current = true
  const job = await waitRestoredAutoJob('job', { isCurrent: () => current,
    get: async id => { current = false; return { id, status: 'succeeded' } } })
  assert.equal(job, null)
})

test('invalid or foreign saved receipts fail closed before candidate restoration', () => {
  const args = request(), receipt = autoJobReceipt(args, 1)
  for (const change of [{ user_id: '2' }, { request_id: crypto.randomUUID() }, { state: 'invented' },
    { request: { ...receipt.request, params: { ...args.params, exposure: 99 } } }])
    assert.throws(() => validateAutoJobReceipt({ ...receipt, ...change }, 1, args.workspace_id))
})
