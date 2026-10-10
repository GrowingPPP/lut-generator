import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { createWorkspaceState, commitEdit } from '../src/lib/workspace.js'
import {
  effectivePhases,
  parameterSignature,
  versionSource,
  equivalentCandidate,
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
