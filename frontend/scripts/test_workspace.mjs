import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { createWorkspaceState, beginEdit, previewEdit, commitEdit, undoEdit, redoEdit,
  serializeWorkspaceState, validateWorkspaceRecord, setWorkspaceMeta, applyRecipeEdit,
  restoreVersionEdit } from '../src/lib/workspace.js'
import { buildStyleRecipe } from '../src/lib/styleRecipe.js'
import { createMemoryDraftStorage, createDraftStorage, PREVIEW_TTL_MS, PREVIEW_BUDGET_BYTES } from '../src/lib/draftStorage.js'

test('new and migrated workspaces use distinct UUIDs and the appropriate goal and source defaults', () => {
  const first = createWorkspaceState({ params: defaultParams(), legacy: false })
  const second = createWorkspaceState({ params: defaultParams(), legacy: true })
  assert.notEqual(first.workspace.id, second.workspace.id)
  assert.equal(first.workspace.goal_mode, 'preserve')
  assert.equal(first.workspace.baseline.classification, 'known')
  assert.equal(second.workspace.goal_mode, 'natural')
  assert.equal(second.workspace.baseline.classification, 'unclassified')
})

test('a complete slider gesture produces one reversible transaction, including refresh mid-gesture', () => {
  let state = beginEdit(createWorkspaceState(), { purpose: 'style' })
  for (let i = 1; i <= 50; i++) state = previewEdit(state, { saturation: i / 100 })
  assert.equal(state.past.length, 0)
  const restored = validateWorkspaceRecord(serializeWorkspaceState(state), 'guest')
  assert.equal(restored.past.length, 1)
  assert.equal(restored.workspace.recipe_projection.operations.saturation.value, 0.5)
  state = commitEdit(state)
  assert.equal(state.past.length, 1)
  const undone = undoEdit(state)
  assert.equal(undone.workspace.params.saturation, 0)
  assert.deepEqual(undone.workspace.recipe_projection.operations, {})
  assert.equal(redoEdit(undone).workspace.params.saturation, 0.5)
})

test('locks and goals are undoable; rejected edits make no transaction; reset preserves locked fields', () => {
  let state = createWorkspaceState()
  state = commitEdit(state, { temp: 300, contrast: 0.2 }, { purpose: 'style' })
  state = commitEdit(state, null, { context: { locked_fields: ['temp'], goal_mode: 'style_only' } })
  assert.throws(() => commitEdit(state, { temp: 400 }), { code: 'locked_fields' })
  assert.throws(() => previewEdit(state, { temp: 400 }), { code: 'locked_fields' })
  assert.equal(state.past.length, 2)
  const reset = commitEdit(state, null, { resetFields: ['temp', 'contrast'] })
  assert.equal(reset.workspace.params.temp, 300)
  assert.equal(reset.workspace.params.contrast, 0)
  assert.deepEqual(reset.workspace.recipe_projection.operations, { temp: { mode: 'add', value: 300 } })
  assert.equal(undoEdit(reset).workspace.params.contrast, 0.2)
  const unlocked = undoEdit(state)
  assert.deepEqual(unlocked.workspace.locked_fields, [])
  assert.equal(unlocked.workspace.goal_mode, 'preserve')
})

test('undo branch clears on a new edit and the 100-transaction bound does not truncate recipe contributions', () => {
  let state = createWorkspaceState()
  for (let i = 1; i <= 120; i++) state = commitEdit(state, { temp: i * 10 }, { purpose: 'style' })
  assert.equal(state.past.length, 100)
  assert.equal(buildStyleRecipe(state.workspace).operations.temp.value, 1200)
  state = undoEdit(state)
  assert.equal(state.future.length, 1)
  state = commitEdit(state, { tint: 10 }, { purpose: 'style' })
  assert.equal(state.future.length, 0)
  assert.equal(buildStyleRecipe(state.workspace).operations.temp.value, 1190)
})

test('multi-stage automatic changes create one transaction without mixing correction into style', () => {
  const before = defaultParams()
  const corrected = { ...before, temp: 600 }
  const styled = { ...corrected, temp: 900, contrast: 0.1 }
  const state = commitEdit(createWorkspaceState(), styled, { source: 'auto', phases: [
    { before_params: before, after_params: corrected, purpose: 'correction', applied: true },
    { before_params: corrected, after_params: styled, purpose: 'style', applied: true },
  ] })
  assert.equal(state.past.length, 1)
  assert.equal(buildStyleRecipe(state.workspace).operations.temp.value, 300)
  assert.equal(undoEdit(state).workspace.params.temp, 0)
})

test('automatic reports restore with their transaction and parameters across undo, redo and draft reload', () => {
  let state = createWorkspaceState()
  assert.equal(state.workspace.report, null)
  const reportA = { id: 'auto-a', params_digest: 'params-a', transaction_id: 'untrusted-id' }
  state = commitEdit(state, { temp: 200 }, { source: 'auto', purpose: 'correction', report: reportA })
  const transactionA = state.past.at(-1).id
  const boundA = { ...reportA, transaction_id: transactionA }
  assert.deepEqual(state.workspace.report, boundA)
  assert.equal(reportA.transaction_id, 'untrusted-id')
  const reportB = { id: 'auto-b', params_digest: 'params-b' }
  state = commitEdit(state, { temp: 500 }, { source: 'auto', purpose: 'correction', report: reportB })
  const boundB = { ...reportB, transaction_id: state.past.at(-1).id }
  assert.deepEqual(state.past.at(-1).before.report, boundA)
  state = validateWorkspaceRecord(serializeWorkspaceState(state), 'guest')
  state = undoEdit(state)
  assert.equal(state.workspace.params.temp, 200)
  assert.deepEqual(state.workspace.report, boundA)
  state = redoEdit(state)
  assert.equal(state.workspace.params.temp, 500)
  assert.deepEqual(state.workspace.report, boundB)
})

test('automatic phases that cancel numerically still bind the report to their source transaction', () => {
  const initial = createWorkspaceState()
  const before = initial.workspace.params
  const corrected = { ...before, temp: 600 }
  const report = { id: 'cancelled-phases', params_digest: 'same-final-params' }
  const state = commitEdit(initial, before, { source: 'auto', report, phases: [
    { before_params: before, after_params: corrected, purpose: 'correction', applied: true },
    { before_params: corrected, after_params: before, purpose: 'style', applied: true },
  ] })
  assert.deepEqual(state.workspace.params, before)
  assert.equal(state.past.length, 1)
  assert.deepEqual(state.workspace.baseline.correction_operations.temp, { mode: 'add', value: 600 })
  assert.deepEqual(buildStyleRecipe(state.workspace).operations.temp, { mode: 'add', value: -600 })
  assert.equal(state.workspace.report.transaction_id, state.past[0].id)
  const undone = undoEdit(state)
  assert.deepEqual(undone.workspace.params, before)
  assert.equal(undone.workspace.report, null)
  assert.deepEqual(undone.workspace.recipe_projection.operations, {})
  assert.deepEqual(redoEdit(undone).workspace.report, state.workspace.report)
})

test('report-only commits do not create edits and old snapshots clear rather than inherit newer reports', () => {
  let state = commitEdit(createWorkspaceState(), { temp: 200 }, { source: 'auto', report: { id: 'auto-a' } })
  const report = state.workspace.report
  state = commitEdit(state, null, { source: 'auto', report: { id: 'skipped' } })
  assert.equal(state.past.length, 1)
  assert.deepEqual(state.workspace.report, report)
  state = setWorkspaceMeta(state, { report: { id: 'failed', status: 'failed' } })
  assert.equal(state.past.length, 1)
  assert.equal(state.workspace.report.id, 'failed')
  const record = serializeWorkspaceState(state)
  delete record.workspace.report
  for (const transaction of record.past) { delete transaction.before.report; delete transaction.after.report }
  const restored = validateWorkspaceRecord(record, 'guest')
  assert.equal(restored.workspace.report, null)
  assert.equal(undoEdit(restored).workspace.report, null)
  assert.equal(record.past[0].before.report, undefined)
})

test('version restore adopts the saved provenance, preserves current locks, and is fully reversible', () => {
  let saved = createWorkspaceState()
  saved = commitEdit(saved, { temp: 600 }, { purpose: 'correction' })
  saved = commitEdit(saved, { temp: 900 }, { purpose: 'style' })
  let current = commitEdit(saved, { temp: 1000 }, { purpose: 'style' })
  current = commitEdit(current, null, { context: { locked_fields: ['temp', 'gain'] } })
  const version = { id: 'version-1', params: saved.workspace.params, source: { workspace_snapshot: saved.workspace } }
  assert.throws(() => restoreVersionEdit(current, version), { code: 'locked_fields' })
  const restored = restoreVersionEdit(current, version, { unlockFields: ['temp'] })
  assert.equal(buildStyleRecipe(restored.workspace).operations.temp.value, 300)
  assert.deepEqual(restored.workspace.locked_fields, ['gain'])
  assert.equal(restored.workspace.associated_version, 'version-1')
  assert.equal(undoEdit(restored).workspace.params.temp, 1000)
})

test('recipe append records actual changes and repeat application requires explicit continuation', () => {
  let source = commitEdit(createWorkspaceState(), { temp: 300 }, { purpose: 'style' })
  const recipe = buildStyleRecipe(source.workspace)
  let target = commitEdit(createWorkspaceState(), { temp: -400 }, { purpose: 'correction' })
  target = applyRecipeEdit(target, recipe)
  assert.equal(target.workspace.params.temp, -100)
  assert.equal(buildStyleRecipe(target.workspace).operations.temp.value, 300)
  assert.throws(() => applyRecipeEdit(target, recipe), { code: 'repeat_recipe' })
  target = applyRecipeEdit(target, recipe, { allowRepeat: true })
  assert.equal(target.workspace.params.temp, 200)
})

test('technical changes preserve the old contract until confirmed and undo restores both state and validation', () => {
  let state = commitEdit(createWorkspaceState(), { contrast: 0.2 }, { purpose: 'style' })
  state = setWorkspaceMeta(state, { validation: { id: 'validation-1', stale: false } })
  const changed = commitEdit(state, { base_photo_style: 'NAT', tone_map: 0.5 })
  assert.equal(changed.workspace.input_status, 'pending_confirmation')
  assert.equal(changed.workspace.recipe_projection.input_contract.base_photo_style, 'STD')
  assert.equal(changed.workspace.validation.stale, true)
  const restored = undoEdit(changed)
  assert.equal(restored.workspace.input_status, 'confirmed')
  assert.equal(restored.workspace.validation.stale, false)
})

test('draft restore rejects another owner and keeps valid current state when only history is incompatible', () => {
  const state = createWorkspaceState({ userId: 'user-a' })
  const record = serializeWorkspaceState(state)
  assert.throws(() => validateWorkspaceRecord(record, 'user-b'), { code: 'invalid_owner' })
  const invalidHistory = { ...record, past: [{ id: 'broken' }] }
  const restored = validateWorkspaceRecord(invalidHistory, 'user-a')
  assert.equal(restored.workspace.params.temp, 0)
  assert.equal(restored.past.length, 0)
  assert.match(restored.historyWarning, /历史/)
  const poisoned = structuredClone(record); poisoned.workspace.params.temp = 4000
  assert.throws(() => validateWorkspaceRecord(poisoned, 'user-a'), { code: 'invalid_params' })
})

test('sample metadata persists but blobs never enter draft or backup snapshots', () => {
  const state = setWorkspaceMeta(createWorkspaceState(), { samples: [{ id: 'sample', name: 'a.jpg',
    source_digest: 'sha', file: new Blob(['source']), preview_blob: new Blob(['preview']) }], primary_sample_id: 'sample' })
  const record = serializeWorkspaceState(state)
  assert.deepEqual(record.workspace.samples, [{ id: 'sample', name: 'a.jpg', source_digest: 'sha' }])
  const restored = validateWorkspaceRecord(record, 'guest')
  assert.equal(restored.workspace.samples[0].needs_rebind, true)
})

test('compare-and-swap permits one writer and isolates accounts without BroadcastChannel', async () => {
  const storage = createMemoryDraftStorage()
  const state = createWorkspaceState({ userId: 'a' })
  const record = serializeWorkspaceState(state)
  const results = await Promise.allSettled([storage.save('a', record, 0), storage.save('a', record, 0)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'revision_conflict')
  assert.equal(await storage.load('b', state.workspace.id), null)
  assert.throws(() => validateWorkspaceRecord(record, 'b'), { code: 'invalid_owner' })
  const latest = await storage.load('a', state.workspace.id)
  assert.equal(latest.workspace.revision, 1)
  await storage.save('a', latest, 1)
  assert.equal((await storage.latest('a')).workspace.revision, 2)
})

test('preview budget, expiry, replacement and clearing are isolated per workspace and account', async () => {
  let timestamp = 10
  const storage = createMemoryDraftStorage({ now: () => timestamp })
  const large = new Blob([new Uint8Array(PREVIEW_BUDGET_BYTES - 10)])
  await storage.putPreview('a', 'w1', 's1', large)
  await assert.rejects(() => storage.putPreview('a', 'w1', 's2', new Blob([new Uint8Array(11)])), { code: 'preview_capacity' })
  await storage.putPreview('a', 'w2', 's1', large)
  assert.equal(await storage.getPreview('b', 'w1', 's1'), null)
  await storage.putPreview('a', 'w1', 's1', new Blob(['replacement']))
  assert.equal((await storage.getPreview('a', 'w1', 's1')).blob.size, 11)
  await storage.clearPreviews('a', 'w1')
  assert.equal(await storage.getPreview('a', 'w1', 's1'), null)
  assert.ok(await storage.getPreview('a', 'w2', 's1'))
  timestamp += PREVIEW_TTL_MS
  assert.equal(await storage.getPreview('a', 'w2', 's1'), null)
})

test('unavailable browser storage reports failure rather than pretending it saved', async () => {
  const storage = createDraftStorage({ indexedDB: null })
  await assert.rejects(() => storage.save('guest', serializeWorkspaceState(createWorkspaceState()), 0), { code: 'storage_unavailable' })
})

test('long editing sessions compact source summaries without losing projection or undo semantics', () => {
  let state = createWorkspaceState()
  for (let i = 1; i <= 600; i++) state = commitEdit(state, { temp: i }, { purpose: 'style' })
  assert.equal(buildStyleRecipe(state.workspace).operations.temp.value, 600)
  assert.ok(state.workspace.recipe_projection.contributions.length <= 32)
  assert.ok(JSON.stringify(state.workspace).length < 24 * 1024)
  const counts = state.workspace.recipe_projection.contributions.reduce((sum, item) => sum + (item.original_transaction_count || 1), 0)
  assert.equal(counts, 600)
  assert.equal(buildStyleRecipe(undoEdit(state).workspace).operations.temp.value, 599)
  const reset = commitEdit(state, null, { resetFields: ['temp'] })
  assert.deepEqual(reset.workspace.recipe_projection.operations, {})
})

test('automatic grading cannot change technical input even when it is not user-locked', () => {
  const state = createWorkspaceState()
  assert.throws(() => commitEdit(state, { base_photo_style: 'NAT' }, { source: 'auto', purpose: 'style' }), { code: 'technical_readonly' })
  assert.equal(state.workspace.params.base_photo_style, 'STD')
  assert.equal(state.past.length, 0)
})
