import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { createWorkspaceState, commitEdit, beginEdit, previewEdit, cancelEdit, undoEdit, redoEdit,
  setWorkspaceMeta, serializeWorkspaceState, validateWorkspaceRecord, restoreVersionEdit } from '../src/lib/workspace.js'
import { STRUCTURED_FIELDS } from '../src/lib/styleRecipe.js'

const stripNew = params => { for (const field of STRUCTURED_FIELDS) delete params[field] }
const changedCurve = () => ({ ...defaultParams().curve_points,
  master: [[0, 0], [.5, .6], [1, 1]] })

test('job UUID overrides a gesture id and the application ledger survives undo, redo and reload', () => {
  const id = crypto.randomUUID()
  let state = beginEdit(createWorkspaceState({ userId: '1' }))
  state = previewEdit(state, { contrast: .1 })
  state = commitEdit(state, null, { source: 'auto', id, report: { job_id: id } })
  assert.equal(state.past[0].id, id)
  assert.equal(state.workspace.report.transaction_id, id)
  state = setWorkspaceMeta(state, { applied_auto_job_ids: [id] })
  assert.equal(state.past.length, 1)
  state = undoEdit(state)
  assert.equal(state.workspace.params.contrast, 0)
  assert.deepEqual(state.workspace.applied_auto_job_ids, [id])
  state = validateWorkspaceRecord(serializeWorkspaceState(state), '1')
  assert.deepEqual(state.workspace.applied_auto_job_ids, [id])
  assert.equal(state.future[0].id, id)
  assert.throws(() => commitEdit(state, { contrast: .1 }, { source: 'auto', id }), { code: 'duplicate_transaction' })
  assert.deepEqual(redoEdit(state).workspace.applied_auto_job_ids, [id])
})

test('applied job metadata validates UUIDs, deduplicates and retains the newest 200 identities', () => {
  const ids = Array.from({ length: 205 }, () => crypto.randomUUID())
  const state = setWorkspaceMeta(createWorkspaceState(), { applied_auto_job_ids: [...ids, ids.at(-1)] })
  assert.deepEqual(state.workspace.applied_auto_job_ids, ids.slice(-200))
  for (const invalid of ['uuid', ['bad'], [null], [true]])
    assert.throws(() => setWorkspaceMeta(state, { applied_auto_job_ids: invalid }), { code: 'invalid_job_ledger' })
  assert.deepEqual(createWorkspaceState().workspace.applied_auto_job_ids, [])
})

test('old 30-field draft, baseline and reversible snapshots gain only the four neutral defaults', () => {
  let state = commitEdit(createWorkspaceState({ userId: '1' }), { contrast: .1 })
  state = commitEdit(state, { exposure: .2 }, { purpose: 'correction' })
  state = undoEdit(state)
  const record = serializeWorkspaceState(state)
  delete record.workspace.applied_auto_job_ids
  for (const snapshot of [record.workspace, ...[...record.past, ...record.future].flatMap(tx => [tx.before, tx.after])]) {
    stripNew(snapshot.params)
    stripNew(snapshot.baseline.params)
  }
  const restored = validateWorkspaceRecord(record, '1')
  assert.equal(restored.historyWarning, null)
  assert.equal(restored.workspace.params.contrast, .1)
  assert.deepEqual(restored.workspace.applied_auto_job_ids, [])
  for (const field of STRUCTURED_FIELDS) {
    assert.deepEqual(restored.workspace.params[field], defaultParams()[field])
    assert.deepEqual(restored.workspace.baseline.params[field], defaultParams()[field])
    assert.deepEqual(restored.past[0].before.params[field], defaultParams()[field])
    assert.deepEqual(restored.future[0].after.params[field], defaultParams()[field])
  }
  assert.equal(undoEdit(restored).workspace.params.contrast, 0)
  assert.equal(redoEdit(restored).workspace.params.exposure, .2)
})

test('migration does not hide invalid present values or invent missing legacy fields', () => {
  const record = serializeWorkspaceState(createWorkspaceState({ userId: '1' }))
  stripNew(record.workspace.params)
  stripNew(record.workspace.baseline.params)
  const invalidValue = structuredClone(record)
  invalidValue.workspace.params.exposure = 99
  assert.throws(() => validateWorkspaceRecord(invalidValue, '1'), { code: 'invalid_params' })
  const missing = structuredClone(record)
  delete missing.workspace.params.temp
  assert.throws(() => validateWorkspaceRecord(missing, '1'), { code: 'invalid_params' })
  const invalidNew = structuredClone(record)
  invalidNew.workspace.params.curve_points = { master: [[0, 1], [0, 1]] }
  assert.throws(() => validateWorkspaceRecord(invalidNew, '1'))
  const badBaseline = structuredClone(record)
  badBaseline.workspace.baseline.params.gain = [1, false, 1]
  assert.throws(() => validateWorkspaceRecord(badBaseline, '1'), { code: 'invalid_params' })
})

test('curve and external correction contributions use SET rather than arithmetic on structured values', () => {
  const id = crypto.randomUUID()
  let state = commitEdit(createWorkspaceState(), { curve_points: changedCurve(), external_lut_id: id,
    external_lut_strength: .3 }, { purpose: 'correction' })
  for (const field of ['curve_points', 'external_lut_id', 'external_lut_strength']) {
    assert.equal(state.workspace.baseline.correction_operations[field].mode, 'set')
    assert.deepEqual(state.workspace.baseline.correction_operations[field].value, state.workspace.params[field])
  }
  state = commitEdit(state, { external_lut_strength: .5 }, { purpose: 'correction' })
  assert.equal(state.workspace.baseline.correction_operations.external_lut_strength.value, .5)
  assert.doesNotMatch(JSON.stringify(state), /NaN/)
  assert.equal(undoEdit(state).workspace.params.external_lut_strength, .3)
})

test('every automatic stage preserves curves and external references even if later stages cancel their values', () => {
  const state = createWorkspaceState()
  const patches = [{ curve_points: changedCurve() }, { external_lut_id: crypto.randomUUID() },
    { external_lut_id: crypto.randomUUID(), external_lut_strength: .2, external_lut_mode: 'display' }]
  for (const patch of patches)
    assert.throws(() => commitEdit(state, patch, { source: 'auto' }), { code: 'technical_readonly' })
  const before = state.workspace.params
  const after = { ...before, curve_points: changedCurve() }
  assert.throws(() => commitEdit(state, before, { source: 'auto', phases: [
    { before_params: before, after_params: after, purpose: 'style' },
    { before_params: after, after_params: before, purpose: 'style' },
  ] }), { code: 'technical_readonly' })
})

test('old named version provenance migrates without overwriting the current application ledger', () => {
  const job = crypto.randomUUID()
  const saved = commitEdit(createWorkspaceState(), { contrast: .2 }).workspace
  stripNew(saved.params)
  stripNew(saved.baseline.params)
  const current = setWorkspaceMeta(createWorkspaceState(), { applied_auto_job_ids: [job] })
  const restored = restoreVersionEdit(current, { id: 'version', params: saved.params, source: { workspace_snapshot: saved } })
  assert.equal(restored.workspace.params.contrast, .2)
  assert.deepEqual(restored.workspace.params.curve_points, defaultParams().curve_points)
  assert.deepEqual(restored.workspace.applied_auto_job_ids, [job])
})

test('cancelled gestures restore parameters and provenance without altering history or applied jobs', () => {
  const id = crypto.randomUUID()
  const base = setWorkspaceMeta(commitEdit(createWorkspaceState(), { contrast: .1 }), { applied_auto_job_ids: [id] })
  const changed = previewEdit(beginEdit(base, { purpose: 'style' }), { curve_points: changedCurve(), exposure: .3 })
  const cancelled = cancelEdit(changed)
  assert.equal(cancelled.pending, null)
  assert.deepEqual(cancelled.workspace.params, base.workspace.params)
  assert.deepEqual(cancelled.workspace.recipe_projection, base.workspace.recipe_projection)
  assert.deepEqual(cancelled.workspace.applied_auto_job_ids, [id])
  assert.equal(cancelled.past, base.past)
  assert.equal(cancelled.future, base.future)
  assert.equal(cancelEdit(base), base)
})
