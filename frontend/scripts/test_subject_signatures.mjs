import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultParams } from '../src/lib/lutEngine.js'
import { contextSignature, reportIsHistorical } from '../src/lib/workspaceFlow.js'
import { matchingAutoResult, sameAutoMetadata } from '../src/lib/autoJobs.js'

const base = { goal_mode: 'preserve', locked_fields: ['temp'], subject_mode: 'unknown' }
const defaults = { subject_detection_mode: 'manual', subject_analysis: null,
  skin_regions: null, skin_mask_mode: 'skin_candidates' }
const region = { bounds: [.2, .1, .4, .3], kind: 'face', confidence: .9 }
const analysis = { version: 'subject-regions-1', status: 'resolved', subject_mode: 'portrait',
  confidence: .9, regions: [region], source: 'auto', reason: 'visible person',
  mask_mode: 'skin_candidates', source_digest: 'a'.repeat(64), input_style: 'STD' }

test('legacy contexts match only the default manual intent and inherit-region sentinel', () => {
  assert.equal(contextSignature(base), contextSignature({ ...base, ...defaults }))
  for (const change of [{ subject_detection_mode: 'auto' }, { skin_regions: [] },
    { skin_regions: [region] }, { skin_mask_mode: 'all_pixels' }, { subject_analysis: analysis }]) {
    assert.notEqual(contextSignature(base), contextSignature({ ...base, ...defaults, ...change }))
  }
})

test('canonical subject evidence ignores object ordering and explanatory text but preserves decisions', () => {
  const context = { ...base, ...defaults, subject_detection_mode: 'auto', subject_analysis: analysis }
  const frozen = structuredClone(context)
  const reordered = { ...context, subject_analysis: Object.fromEntries(Object.entries({
    ...analysis, reason: 'another explanation', regions: [Object.fromEntries(Object.entries(region).reverse())],
  }).reverse()) }
  assert.equal(contextSignature(context), contextSignature(reordered))
  assert.deepEqual(context, frozen)
  for (const change of [{ confidence: .8 }, { source_digest: 'b'.repeat(64) }, { input_style: 'VLOG' },
    { regions: [{ ...region, bounds: [.2, .1, .5, .3] }] },
    { regions: [{ ...region, confidence: .8 }] }, { source: 'manual' }]) {
    assert.notEqual(contextSignature(context), contextSignature({ ...context,
      subject_analysis: { ...analysis, ...change } }))
  }
})

test('invalid subject evidence cannot authorize a restored request', () => {
  const invalid = [
    { subject_detection_mode: null }, { subject_detection_mode: 'automatic' },
    { subject_analysis: [] }, { subject_analysis: undefined }, { skin_regions: undefined },
    { skin_regions: false }, { skin_mask_mode: null },
    { skin_mask_mode: 'color' }, { skin_regions: [null] },
    { skin_regions: [{ ...region, bounds: [0, 0, 1, Infinity] }] },
    { skin_regions: [{ ...region, bounds: [.4, .1, .2, .3] }] },
    { skin_regions: [{ ...region, confidence: NaN }] },
    { skin_regions: [{ ...region, kind: 'person' }] },
    { skin_regions: [{ ...region, extra: true }] },
    { skin_regions: Array.from({ length: 17 }, () => region) },
    ...[{ status: 'failed' }, { status: 'resolved', subject_mode: 'unknown', regions: [] },
      { subject_mode: 'non_portrait' }, { mask_mode: 'all_pixels' }, { source: 'model' },
      { input_style: 'RAW' }, { source_digest: 1 }, { confidence: false },
      { version: 'future' }, { extra: true }, { reason: 'x'.repeat(257) }]
      .map(change => ({ subject_analysis: { ...analysis, ...change } })),
  ]
  for (const change of invalid) assert.equal(contextSignature({ ...base, ...defaults, ...change }), null)
})

test('valid unavailable and manual analysis structures retain their explicit state', () => {
  for (const status of ['uncertain', 'failed', 'disabled']) {
    assert.ok(contextSignature({ ...base, ...defaults, subject_analysis: {
      ...analysis, status, subject_mode: 'unknown', regions: [], confidence: 0, reason: null,
      source_digest: null, input_style: null,
    } }))
  }
  assert.ok(contextSignature({ ...base, ...defaults, subject_analysis: {
    ...analysis, source: 'manual', mask_mode: 'all_pixels',
  } }))
})

test('regions, automatic mode and source evidence participate in report and result matching', () => {
  const request = { request_id: 'job', params: defaultParams(), workspace_id: 'workspace',
    source_digest: 'source', main_sample_id: 'main', context: { ...base, ...defaults } }
  const report = { params: request.params, before_params: request.params, context: request.context,
    workspace_id: request.workspace_id, source_digest: request.source_digest, main_sample_id: 'main' }
  const current = { params: request.params, primaryId: 'main', sourceDigest: 'source', context: request.context }
  assert.equal(reportIsHistorical(report, current), false)
  for (const change of [{ subject_detection_mode: 'auto' }, { skin_regions: [] }, { skin_regions: [region] },
    { subject_analysis: analysis }, { skin_mask_mode: 'all_pixels' }]) {
    const context = { ...request.context, ...change }
    assert.equal(reportIsHistorical(report, { ...current, context }), true)
    assert.equal(sameAutoMetadata(request, { ...request, context }), false)
    assert.equal(matchingAutoResult(request, { id: 'job', result: { ...report, context } }), false)
  }
})
