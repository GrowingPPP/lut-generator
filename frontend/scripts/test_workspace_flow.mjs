import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { createWorkspaceState, commitEdit } from '../src/lib/workspace.js'
import {
  effectivePhases,
  parameterSignature,
  versionSource,
  equivalentCandidate,
  contextSignature,
  reportIsHistorical,
} from '../src/lib/workspaceFlow.js'

test('chat response provenance respects the user purpose and uses only effective stages', () => {
  const before = defaultParams(),
    after = { ...before, contrast: 0.2 }
  const response = {
    steps: [
      {
        applied: true,
        purpose: 'unclassified',
        stage: 'chat',
        params_before: before,
        params_after: after,
      },
      {
        applied: false,
        stage: 'style',
        params_before: after,
        params_after: { ...after, temp: 500 },
      },
    ],
  }
  const style = commitEdit(createWorkspaceState(), after, {
    source: 'chat',
    phases: effectivePhases(response, { chatPurpose: 'style' }),
  })
  assert.equal(style.workspace.recipe_projection.operations.contrast.value, 0.2)
  assert.equal(style.past.length, 1)
  const correction = commitEdit(createWorkspaceState(), after, {
    source: 'chat',
    phases: effectivePhases(response, { chatPurpose: 'correction' }),
  })
  assert.deepEqual(correction.workspace.recipe_projection.operations, {})
})

test('automatic effective phases preserve single-photo correction separately from style', () => {
  const before = defaultParams(),
    correction = { ...before, temp: 600 },
    after = { ...correction, temp: 900 }
  const state = commitEdit(createWorkspaceState(), after, {
    source: 'auto',
    phases: effectivePhases({
      steps: [
        {
          applied: true,
          stage: 'optimize',
          purpose: 'correction',
          params_before: before,
          params_after: correction,
        },
        {
          applied: true,
          stage: 'style',
          purpose: 'style',
          params_before: correction,
          params_after: after,
        },
      ],
    }),
  })
  assert.equal(state.workspace.recipe_projection.operations.temp.value, 300)
})

test('request and report signatures do not depend on API object property order', () => {
  const params = defaultParams()
  const reversed = Object.fromEntries(Object.entries(params).reverse())
  assert.equal(parameterSignature(params), parameterSignature(reversed))
  assert.notEqual(parameterSignature(params), parameterSignature({ ...params, exposure: 0.1 }))
})

test('version source retains exact provenance without photos or historical diagnostics', () => {
  const workspace = {
    ...createWorkspaceState().workspace,
    report: { reply: 'x' },
    validation: { results: [] },
    samples: [{ id: 'photo' }],
    primary_sample_id: 'photo',
  }
  const source = versionSource(workspace)
  assert.deepEqual(source.workspace_snapshot.recipe_projection, workspace.recipe_projection)
  assert.equal(source.workspace_snapshot.samples, undefined)
  assert.equal(source.workspace_snapshot.report, undefined)
  assert.equal(source.workspace_snapshot.validation, undefined)
})

test('computed candidate comparison accepts floating tails and rejects changed values and nonfinite inputs', () => {
  const params = defaultParams()
  assert.ok(
    equivalentCandidate(
      { ...params, hue: 0.10000000000002274 },
      { ...params, hue: 0.09999999999999432 },
    ),
  )
  assert.equal(equivalentCandidate(params, { ...params, exposure: 0.01 }), false)
  assert.equal(equivalentCandidate(params, { ...params, temp: NaN }), false)
})

const reportFixture = () => {
  const params = defaultParams()
  const context = { goal_mode: 'preserve', locked_fields: ['temp', 'exposure'] }
  return {
    report: {
      params: structuredClone(params),
      main_sample_id: 'primary-photo',
      source_digest: 'original-digest',
      context: structuredClone(context),
    },
    current: { params, primaryId: 'primary-photo', sourceDigest: 'original-digest', context },
  }
}

test('context signatures compare a protected set without mutating or depending on lock order', () => {
  const context = { goal_mode: 'preserve', locked_fields: ['temp', 'exposure', 'temp'] }
  const copy = structuredClone(context)
  assert.equal(contextSignature(context), contextSignature({
    goal_mode: 'preserve', locked_fields: ['exposure', 'temp'],
  }))
  assert.deepEqual(context, copy)
  assert.notEqual(contextSignature(context), contextSignature({
    goal_mode: 'natural', locked_fields: ['temp', 'exposure'],
  }))
  assert.notEqual(contextSignature(context), contextSignature({
    goal_mode: 'preserve', locked_fields: ['exposure'],
  }))
})

test('missing or malformed report context is never assigned current defaults', () => {
  for (const context of [undefined, null, {}, [], { goal_mode: 'preserve' },
    { locked_fields: [] }, { goal_mode: 'unknown', locked_fields: [] },
    { goal_mode: 'preserve', locked_fields: null },
    { goal_mode: 'preserve', locked_fields: ['unknown'] }]) {
    assert.equal(contextSignature(context), null)
    const { report, current } = reportFixture()
    report.context = context
    report.goal_mode = current.context.goal_mode
    report._context_json = contextSignature(current.context)
    assert.equal(reportIsHistorical(report, current), true)
  }
})

test('server report source and complete context identify the current result without client metadata', () => {
  const { report, current } = reportFixture()
  assert.equal(reportIsHistorical(report, current), false)
  current.context.locked_fields.reverse()
  assert.equal(reportIsHistorical(report, current), false)
  report.params = Object.fromEntries(Object.entries(report.params).reverse())
  assert.equal(reportIsHistorical(report, current), false)
})

test('reports become historical for each changed parameter, photo source, goal or protection set', () => {
  const modifications = [
    current => { current.params.exposure = 0.02 },
    current => { current.primaryId = 'other-photo' },
    current => { current.sourceDigest = 'replaced-original-digest' },
    current => { current.context.goal_mode = 'natural' },
    current => { current.context.locked_fields = ['temp'] },
    current => { current.context.locked_fields.push('contrast') },
    current => { current.params.curve_points.r = [[0, 0], [0.5, 0.6], [1, 1]] },
    current => { current.params.external_lut_strength = 0.5 },
  ]
  for (const modify of modifications) {
    const { report, current } = reportFixture()
    modify(current)
    assert.equal(reportIsHistorical(report, current), true)
  }
})

test('frozen request context takes precedence over a report context and never falls through when unknown', () => {
  const { report, current } = reportFixture()
  report._request_context = structuredClone(current.context)
  report.context = { goal_mode: 'natural', locked_fields: [] }
  assert.equal(reportIsHistorical(report, current), false)
  report._request_context.goal_mode = 'style_only'
  assert.equal(reportIsHistorical(report, current), true)
  report._request_context = null
  report.context = structuredClone(current.context)
  assert.equal(reportIsHistorical(report, current), true)
})

test('frozen photo metadata identifies the original source rather than a later response field', () => {
  const { report, current } = reportFixture()
  report._sample_id = current.primaryId
  report._source_digest = current.sourceDigest
  report.main_sample_id = 'other-photo'
  report.source_digest = 'other-digest'
  assert.equal(reportIsHistorical(report, current), false)
  report._sample_id = 'previous-photo'
  assert.equal(reportIsHistorical(report, current), true)
})

test('actual result parameters supersede a stale cached signature and equality does not imply application', () => {
  const { report, current } = reportFixture()
  report._params_json = parameterSignature(current.params)
  report.params.contrast = 0.2
  assert.equal(reportIsHistorical(report, current), true)
  report.params.contrast = current.params.contrast
  report._applied_at = undefined
  report.job_id = 'not-in-an-application-ledger'
  assert.equal(reportIsHistorical(report, current), false)
})

test('a missing result or current context remains historical without throwing', () => {
  const { report, current } = reportFixture()
  assert.equal(reportIsHistorical(null, current), true)
  assert.equal(reportIsHistorical(report), true)
  assert.equal(reportIsHistorical({ ...report, params: null }, current), true)
  assert.equal(reportIsHistorical(report, { ...current, context: undefined }), true)
})
