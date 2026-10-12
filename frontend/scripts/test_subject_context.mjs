import assert from 'node:assert/strict'
import test from 'node:test'
import * as samples from '../src/lib/samples.js'
import { defaultParams } from '../src/lib/lutEngine.js'
import { contextSignature, reportIsHistorical } from '../src/lib/workspaceFlow.js'
import { captureAutoRequest, sameAutoMetadata, matchingAutoResult, jobProgressSteps } from '../src/lib/autoJobs.js'
import { autoJobReceipt, validateAutoJobReceipt, createMemoryAutoJobStorage } from '../src/lib/autoJobStorage.js'
import { reviewSkipText } from '../src/lib/autoGrade.js'

const context = { goal_mode: 'preserve', locked_fields: ['gain'] }
const request = (subject_mode) => captureAutoRequest({ params: defaultParams(),
  context: { ...context, ...(subject_mode === undefined ? {} : { subject_mode }) },
  workspace_id: crypto.randomUUID(), source_digest: 'a'.repeat(64), main_sample_id: 'main' })

test('changing photo content evidence makes an otherwise identical report historical', () => {
  const params = defaultParams()
  const report = { params, context: { ...context, subject_mode: 'portrait' }, main_sample_id: 'main', source_digest: 'digest' }
  assert.equal(reportIsHistorical(report, { params, primaryId: 'main', sourceDigest: 'digest',
    context: { ...context, subject_mode: 'non_portrait' } }), true)
  assert.equal(contextSignature(context), contextSignature({ ...context, subject_mode: 'unknown' }))
})

test('restored request and candidate matching reject a changed photo content annotation', () => {
  const captured = request('portrait')
  const changed = { ...captured, context: { ...context, subject_mode: 'non_portrait' } }
  assert.equal(sameAutoMetadata(captured, changed), false)
  const result = { before_params: captured.params, workspace_id: captured.workspace_id,
    source_digest: captured.source_digest, main_sample_id: captured.main_sample_id, context: changed.context }
  assert.equal(matchingAutoResult(captured, { id: captured.request_id, result }), false)
})

test('receipts reject explicitly invalid subject modes instead of silently restoring them', () => {
  for (const value of [null, '', 'landscape', false, 0, [], ['portrait'], {}, 'toString']) {
    const args = request(value)
    assert.throws(() => autoJobReceipt(args, 1), error => error.code === 'invalid_context')
    const valid = autoJobReceipt(request(), 1)
    valid.request.context.subject_mode = value
    assert.throws(() => validateAutoJobReceipt(valid, 1, valid.workspace_id), error => error.code === 'invalid_context')
  }
})

test('sample context follows each actual photo and migrates invalid old annotations to unknown', () => {
  assert.equal(typeof samples.editingContextForSample, 'function')
  const workspace = { ...context, subject_mode: 'portrait' }
  for (const subject_mode of ['unknown', 'portrait', 'non_portrait']) {
    const expected = { ...context, subject_mode, subject_detection_mode: subject_mode === 'unknown' ? 'auto' : 'manual',
      subject_analysis: null, skin_regions: null, skin_mask_mode: 'skin_candidates' }
    assert.deepEqual(samples.editingContextForSample(workspace, { metadata: { subject_mode } }), expected)
    assert.deepEqual(samples.editingContextForSample(workspace, { subject_mode }), expected)
  }
  for (const value of [undefined, null, '', 'person', 1, [], ['portrait'], {}, 'toString']) {
    assert.equal(samples.normalizeSubjectMode(value), 'unknown')
    assert.equal(samples.editingContextForSample(workspace, { subject_mode: value }).subject_mode, 'unknown')
  }
  assert.equal(samples.editingContextForSample(workspace, null).subject_mode, 'unknown')
  const derived = samples.editingContextForSample(workspace, { subject_mode: 'non_portrait' })
  derived.locked_fields.push('temp')
  assert.deepEqual(workspace.locked_fields, ['gain'])
})

test('review progress and report text explain unchanged effects and empty model reviews', () => {
  for (const [reason, wording] of [['unchanged', /实际效果未变化/], ['empty', /未返回有效意见/],
    ['locked', /保护/], ['not_requested', /未请求/]]) {
    assert.match(reviewSkipText(reason), wording)
    const [stage] = jobProgressSteps({ stages: [{ stage: 'review', state: 'skipped', reason }] })
    assert.match(stage.detail, wording)
  }
})

test('legacy receipts keep the exact frozen request shape when loaded and retried', async () => {
  const args = request()
  const storage = createMemoryAutoJobStorage()
  const first = await storage.begin(1, args)
  const frozen = JSON.stringify(first.request)
  const loaded = await storage.load(1, args.workspace_id)
  assert.equal(JSON.stringify(loaded.request), frozen)
  assert.equal(Object.hasOwn(loaded.request.context, 'subject_mode'), false)
  assert.equal(JSON.stringify((await storage.begin(1, loaded.request)).request), frozen)
})

test('valid receipt modes persist unchanged and legacy omission matches explicit unknown only', async () => {
  for (const subject_mode of ['unknown', 'portrait', 'non_portrait']) {
    const args = request(subject_mode), storage = createMemoryAutoJobStorage()
    await storage.begin(1, args)
    const loaded = await storage.load(1, args.workspace_id)
    assert.equal(loaded.request.context.subject_mode, subject_mode)
    assert.equal(sameAutoMetadata(loaded.request, args), true)
    const result = { before_params: args.params, context: args.context, workspace_id: args.workspace_id,
      source_digest: args.source_digest, main_sample_id: args.main_sample_id }
    assert.equal(matchingAutoResult(args, { id: args.request_id, result }), true)
  }
  const legacy = request()
  assert.equal(sameAutoMetadata(legacy, { ...legacy, context: { ...context, subject_mode: 'unknown' } }), true)
  assert.equal(sameAutoMetadata(legacy, { ...legacy, context: { ...context, subject_mode: 'portrait' } }), false)
  for (const subject_mode of [null, '', false, ['portrait']]) {
    assert.equal(contextSignature({ ...context, subject_mode }), null)
    assert.equal(sameAutoMetadata(legacy, { ...legacy, context: { ...context, subject_mode } }), false)
  }
})

function mockPhotoBrowser(t) {
  for (const [key, value] of Object.entries({
    Image: class { naturalWidth = 8; naturalHeight = 8; async decode() {} },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'thumbnail' }) },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] })
  }
}

test('fresh source defaults to unknown and rebinding the same SHA preserves per-photo annotation', async t => {
  mockPhotoBrowser(t)
  const file = Object.assign(new Blob(['source'], { type: 'image/jpeg' }), { name: 'Tree.jpg' })
  const source_digest = await samples.contentDigest(file)
  const photoMetadata = { source_digest, width: 8, height: 8, source_width: 8, source_height: 8,
    color_management: { version: 1, input_style: 'STD' } }
  t.mock.method(globalThis, 'fetch', async () => new Response(new Blob(['normalized']),
    { status: 200, headers: { 'X-Photo-Metadata': JSON.stringify(photoMetadata) } }))
  const first = await samples.decodeSample(file, defaultParams())
  assert.equal(first.metadata.subject_mode, 'unknown')
  const existing = { ...first.metadata, subject_selection: 'portrait', subject_mode: 'portrait', input_confirmed: true }
  const frozen = structuredClone(existing)
  const rebound = await samples.decodeSample(file, defaultParams(), existing)
  assert.equal(rebound.metadata.subject_mode, 'portrait')
  assert.equal(rebound.metadata.id, existing.id)
  assert.equal(rebound.metadata.input_confirmed, true)
  assert.deepEqual(existing, frozen)
  await assert.rejects(samples.decodeSample(Object.assign(new Blob(['different']), { name: 'other.jpg' }), defaultParams(), existing), /不同/)
})

test('restored preview retains valid per-photo annotations and migrates missing or invalid metadata', async t => {
  mockPhotoBrowser(t)
  for (const subject_mode of [undefined, 'unknown', 'portrait', 'non_portrait', 'landscape', ['portrait']]) {
    const metadata = { id: 'main', source_digest: 'digest', ...(subject_mode === undefined ? {} : { subject_mode }) }
    const frozen = structuredClone(metadata)
    const restored = await samples.restoreSample(new Blob(['preview']), metadata)
    assert.equal(restored.metadata.subject_mode, samples.normalizeSubjectMode(subject_mode))
    assert.equal(restored.metadata.id, 'main')
    assert.equal(restored.metadata.needs_rebind, true)
    assert.deepEqual(metadata, frozen)
  }
})

test('restoring a known preview checks its pixels instead of relabeling a stale cached blob', async t => {
  mockPhotoBrowser(t)
  const preview = new Blob(['current-preview'])
  const metadata = { id: 'main', source_digest: 'original', preview_digest: await samples.contentDigest(preview) }
  const restored = await samples.restoreSample(preview, metadata)
  assert.equal(restored.metadata.preview_digest, metadata.preview_digest)
  assert.equal(restored.file, null)
  await assert.rejects(samples.restoreSample(new Blob(['old-preview']), metadata), /缓存预览与样张不一致/)
})
