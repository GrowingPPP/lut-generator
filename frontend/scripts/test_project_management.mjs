import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceState, commitEdit, beginEdit, previewEdit, undoEdit, redoEdit,
  setWorkspaceMeta, serializeWorkspaceState } from '../src/lib/workspace.js'
import { duplicateWorkspaceState, duplicateProjectName, renameWorkspaceState, projectName,
  createProjectDeletionJournal } from '../src/lib/projectManagement.js'
import { createMemoryDraftStorage, createDraftStorage, PREVIEW_TTL_MS } from '../src/lib/draftStorage.js'

function memoryLocalStorage() {
  const records = new Map()
  return { get length() { return records.size }, key: i => [...records.keys()][i],
    getItem: key => records.has(key) ? records.get(key) : null,
    setItem: (key, value) => records.set(key, String(value)) }
}

function completeProject() {
  let state = createWorkspaceState({ userId: '7', sessionId: 42, name: '春日清透' })
  state = commitEdit(state, { temp: 100, saturation: -.1,
    curve_points: { ...state.workspace.params.curve_points, master: [[0, 0], [.5, .6], [1, 1]] },
    external_lut_id: crypto.randomUUID(), external_lut_strength: .25 })
  state = commitEdit(state, null, { context: { goal_mode: 'style_only', locked_fields: ['temp'] } })
  state = setWorkspaceMeta(state, { samples: [{ id: 'sample-one', source_digest: 'a'.repeat(64),
    input_confirmed: true, input_contract: { base_photo_style: 'STD', output_encoding: 'srgb' },
    subject_selection: 'auto', subject_analysis: { subject_mode: 'non_portrait', regions: [], confidence: .96 } }],
    primary_sample_id: 'sample-one', retain_previews: true,
    view_state: { selected_sample_id: 'sample-one', display_mode: 'slider', split: .7,
      curves_open: true, comparison: { a: { id: 'original-version' } } },
    report: { id: 'report' }, validation: { status: 'passed' }, associated_version: 'original-version',
    applied_auto_job_ids: [crypto.randomUUID()] })
  return state
}

test('copy is an independent latest editing snapshot with preserved samples and clean job/history state', () => {
  const source = previewEdit(beginEdit(completeProject()), { contrast: .18 })
  const before = structuredClone(source)
  const id = crypto.randomUUID()
  const copy = duplicateWorkspaceState(source, { id, sessionId: 99 })
  assert.deepEqual(source, before)
  assert.equal(copy.workspace.id, id)
  assert.equal(copy.workspace.session_id, 99)
  assert.equal(copy.workspace.name, '春日清透 副本')
  assert.equal(copy.workspace.revision, 0)
  assert.equal(copy.workspace.params.contrast, .18)
  assert.deepEqual(copy.workspace.params.curve_points, source.workspace.params.curve_points)
  assert.equal(copy.workspace.params.external_lut_id, source.workspace.params.external_lut_id)
  for (const field of ['samples', 'primary_sample_id', 'locked_fields', 'goal_mode', 'input_status', 'retain_previews'])
    assert.deepEqual(copy.workspace[field], source.workspace[field])
  for (const field of ['display_mode', 'split', 'selected_sample_id', 'curves_open'])
    assert.deepEqual(copy.workspace.view_state[field], source.workspace.view_state[field])
  assert.equal(copy.workspace.view_state.comparison, null)
  for (const field of ['associated_version', 'report', 'validation']) assert.equal(copy.workspace[field], null)
  assert.deepEqual(copy.workspace.applied_auto_job_ids, [])
  assert.deepEqual(copy.past, []); assert.deepEqual(copy.future, []); assert.equal(copy.pending, null)
  copy.workspace.samples[0].subject_analysis.confidence = .5
  assert.equal(source.workspace.samples[0].subject_analysis.confidence, .96)
  assert.throws(() => duplicateWorkspaceState(source, { id: source.workspace.id }), { code: 'invalid_project_copy' })
})

test('project rename is trimmed, bounded and survives later undo and redo', () => {
  const source = completeProject()
  const renamed = renameWorkspaceState(source, '  新名字  ')
  assert.equal(renamed.workspace.name, '新名字')
  assert.equal(undoEdit(renamed).workspace.name, '新名字')
  assert.equal(redoEdit(undoEdit(renamed)).workspace.name, '新名字')
  assert.equal(source.workspace.name, '春日清透')
  assert.equal(projectName('色'.repeat(160)).length, 160)
  assert.equal([...projectName('🎨'.repeat(160))].length, 160)
  for (const name of ['', '  ', '色'.repeat(161), '新\n名字', 123])
    assert.throws(() => projectName(name), { code: 'invalid_project_name' })
  const longName = duplicateProjectName('色'.repeat(160))
  assert.equal([...longName].length, 160)
  assert.ok(longName.endsWith(' 副本'))
})

test('preview copy remains account isolated and does not extend cache retention', async () => {
  let now = 100
  const storage = createMemoryDraftStorage({ now: () => now })
  const source = completeProject(), copy = duplicateWorkspaceState(source, { sessionId: 99 })
  await storage.save('7', serializeWorkspaceState(source))
  await storage.putPreview('7', source.workspace.id, 'sample-one', new Blob(['preview']), { source_digest: 'a'.repeat(64) })
  await storage.putPreview('7', source.workspace.id, 'removed', new Blob(['removed']))
  await storage.putPreview('8', source.workspace.id, 'sample-one', new Blob(['foreign']))
  now += 200
  assert.equal(await storage.copyPreviews('7', source.workspace.id, copy.workspace.id, ['sample-one']), 1)
  const copied = await storage.getPreview('7', copy.workspace.id, 'sample-one')
  assert.equal(copied.workspace_id, copy.workspace.id)
  assert.equal(await copied.blob.text(), 'preview')
  assert.equal(copied.expires_at, 100 + PREVIEW_TTL_MS)
  assert.equal(await storage.getPreview('7', copy.workspace.id, 'removed'), null)
  assert.equal(await storage.getPreview('8', copy.workspace.id, 'sample-one'), null)
  now = copied.expires_at
  assert.equal(await storage.getPreview('7', copy.workspace.id, 'sample-one'), null)
})

test('retiring a project removes its draft and previews but preserves other projects and owners', async () => {
  const storage = createMemoryDraftStorage(), source = completeProject()
  const copy = duplicateWorkspaceState(source, { sessionId: 99 })
  const original = serializeWorkspaceState(source)
  const sourceSaved = await storage.save('7', original)
  await storage.save('7', serializeWorkspaceState(copy))
  const foreign = structuredClone(original); foreign.workspace.user_id = '8'
  await storage.save('8', foreign)
  const photo = new Blob(['original file stays held by caller'])
  await storage.putPreview('7', source.workspace.id, 'sample-one', photo)
  await storage.copyPreviews('7', source.workspace.id, copy.workspace.id)
  await storage.putPreview('8', source.workspace.id, 'sample-one', new Blob(['foreign']))
  await storage.retire('7', source.workspace.id)
  assert.equal(await storage.load('7', source.workspace.id), null)
  assert.equal(await storage.getPreview('7', source.workspace.id, 'sample-one'), null)
  assert.equal((await storage.latest('7')).workspace.id, copy.workspace.id)
  assert.ok(await storage.load('8', source.workspace.id))
  assert.ok(await storage.getPreview('8', source.workspace.id, 'sample-one'))
  assert.equal(await photo.text(), 'original file stays held by caller')
  assert.equal(await (await storage.getPreview('7', copy.workspace.id, 'sample-one')).blob.text(), await photo.text())
  assert.deepEqual(await storage.deletedIds('7'), [source.workspace.id])
  await assert.rejects(storage.save('7', sourceSaved, sourceSaved.workspace.revision), { code: 'project_deleted' })
  await assert.rejects(storage.save('7', original, 0), { code: 'project_deleted' })
  await assert.rejects(storage.putPreview('7', source.workspace.id, 'late', new Blob(['late'])), { code: 'project_deleted' })
  await assert.rejects(storage.copyPreviews('7', copy.workspace.id, source.workspace.id), { code: 'project_deleted' })
  await storage.retire('7', source.workspace.id)
  assert.deepEqual(await storage.deletedIds('8'), [])
})

test('deletion journal survives a failed IndexedDB cleanup and blocks reload restoration and stale saves', async () => {
  const localStorage = memoryLocalStorage()
  const journal = createProjectDeletionJournal({ localStorage })
  const source = completeProject(), id = source.workspace.id
  const storage = createDraftStorage({ indexedDB: null, deletionJournal: journal })
  await assert.rejects(storage.retire('7', id), error => error.code === 'storage_unavailable' && error.deletionPersisted)
  const afterReload = createDraftStorage({ indexedDB: null,
    deletionJournal: createProjectDeletionJournal({ localStorage }) })
  assert.equal(await afterReload.isDeleted('7', id), true)
  assert.equal(await afterReload.load('7', id), null)
  assert.deepEqual(await afterReload.deletedIds('7'), [id])
  await assert.rejects(afterReload.save('7', serializeWorkspaceState(source)), { code: 'project_deleted' })
  await assert.rejects(afterReload.putPreview('7', id, 'sample-one', new Blob(['late'])), { code: 'project_deleted' })
  assert.equal(createProjectDeletionJournal({ localStorage }).has('8', id), false)
})

test('deletion fences remain active in this tab when both persistent stores are unavailable', async () => {
  const localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  const journal = createProjectDeletionJournal({ localStorage })
  const source = completeProject(), id = source.workspace.id
  const storage = createDraftStorage({ indexedDB: null, deletionJournal: journal })
  await assert.rejects(storage.retire('7', id), error => error.deletionPersisted === false)
  assert.equal(await storage.isDeleted('7', id), true)
  assert.deepEqual(journal.ids('7'), [id])
  await assert.rejects(storage.save('7', serializeWorkspaceState(source)), { code: 'project_deleted' })
})

test('all local project stores are attempted and cleanup failures remain visible', async () => {
  const { retireLocalProject } = await import('../src/lib/projectManagement.js')
  const calls = []
  await assert.rejects(retireLocalProject({ userId: '7', id: 'project',
    draftStorage: { async retire() { calls.push('draft'); throw new Error('draft denied') } },
    jobStorage: { async remove() { calls.push('job'); throw new Error('job denied') } },
  }), error => error.code === 'project_cleanup_failed' && error.cleanupFailures.length === 2)
  assert.deepEqual(calls, ['draft', 'job'])
  assert.equal(await retireLocalProject({ userId: '7', id: 'project',
    draftStorage: { async retire() { return true } }, jobStorage: { async remove() { return true } } }), true)
})

// Exercise the asynchronous hook without a browser: the small hook host runs
// React's state/effect contract and real storage logic, with controllable writes.
test('hook blocks late saves after deletion, retains the replacement and reports copy/rename save failures', async () => {
  const { build } = await import('esbuild')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const { createMemoryAutoJobStorage } = await import('../src/lib/autoJobStorage.js')
  const directory = await mkdtemp(join(tmpdir(), 'chroma-project-hook-'))
  const reactMock = join(directory, 'react.mjs'), entry = join(directory, 'entry.mjs'), bundle = join(directory, 'bundle.mjs')
  const originalBroadcast = globalThis.BroadcastChannel
  let harness
  const additionalHarnesses = []
  try {
    await writeFile(reactMock, `
      let active;
      export function createHarness() {
        const host = { values: [], effects: [], cleanups: [], pending: [] };
        return {
          render(fn) {
            active = host; host.cursor = 0; host.effectCursor = 0; host.pending = [];
            const result = fn(); active = null;
            for (const run of host.pending) run();
            return result;
          },
          unmount() { for (const cleanup of host.cleanups) cleanup?.(); }
        };
      }
      export function useState(initial) {
        const host = active, index = host.cursor++;
        if (!(index in host.values)) host.values[index] = typeof initial === 'function' ? initial() : initial;
        return [host.values[index], value => { host.values[index] = typeof value === 'function' ? value(host.values[index]) : value; }];
      }
      export function useRef(initial) { return useState(() => ({ current: initial }))[0]; }
      export function useCallback(callback) { return callback; }
      export function useEffect(callback, deps) {
        const host = active, index = host.effectCursor++;
        if (!host.effects[index] || deps.some((value, i) => value !== host.effects[index][i])) {
          host.effects[index] = deps;
          host.pending.push(() => { host.cleanups[index]?.(); host.cleanups[index] = callback(); });
        }
      }
    `)
    const hookPath = fileURLToPath(new URL('../src/hooks/useWorkspace.js', import.meta.url))
    await writeFile(entry, `export { default as useWorkspace } from ${JSON.stringify(hookPath)}; export { createHarness } from ${JSON.stringify(reactMock)};`)
    await build({ entryPoints: [entry], bundle: true, outfile: bundle, format: 'esm', platform: 'node', alias: { react: reactMock } })
    const { useWorkspace, createHarness } = await import(pathToFileURL(bundle))
    globalThis.BroadcastChannel = undefined
    harness = createHarness()
    const storage = createMemoryDraftStorage(), jobStorage = createMemoryAutoJobStorage()
    const props = { userId: '7', storage, jobStorage }
    const render = () => harness.render(() => useWorkspace(props))
    render()
    await new Promise(resolve => setImmediate(resolve))
    let editor = render()
    assert.equal(editor.ready, true)
    assert.ok(await editor.flush())
    editor = render()
    const sourceId = editor.workspace.id
    editor.commit({ contrast: .2 })
    assert.ok(await editor.flush())
    editor = render()
    const save = storage.save.bind(storage)
    storage.save = async () => { throw new Error('disk full') }
    assert.equal(await editor.renameProject('新名称'), null)
    editor = render()
    assert.equal(editor.saveStatus, 'unsaved')
    assert.equal(editor.workspace.name, '新名称')
    storage.save = save
    assert.ok(await editor.renameProject('新名称'))
    editor = render()
    assert.equal(editor.workspace.name, '新名称')
    const copyId = crypto.randomUUID()
    const copied = await editor.duplicateProject({ id: copyId, sessionId: 99 })
    assert.equal(copied.id, copyId)
    editor = render()
    assert.equal(editor.workspace.params.contrast, .2)
    assert.deepEqual(editor.histories.past, [])
    assert.equal((await editor.listProjects()).length, 2)

    let releaseWrite, writeStarted
    const gate = new Promise(resolve => { releaseWrite = resolve })
    const started = new Promise(resolve => { writeStarted = resolve })
    storage.save = async (...args) => { writeStarted(); await gate; return save(...args) }
    const lateSave = editor.flush()
    await started
    assert.equal(await editor.retireProject(copyId), true)
    editor = render()
    assert.equal(editor.ready, false)
    const replacementId = crypto.randomUUID()
    assert.ok(await editor.loadWorkspace({ id: replacementId, name: '替代项目' }))
    releaseWrite()
    assert.equal(await lateSave, null)
    storage.save = save
    editor = render()
    assert.equal(editor.workspace.id, replacementId)
    assert.equal(editor.workspace.name, '替代项目')
    assert.ok(await editor.flush())
    assert.equal(await storage.load('7', copyId), null)
    assert.ok(await storage.load('7', sourceId))
    assert.deepEqual(await editor.deletedProjectIds(), [copyId])
    assert.equal(await editor.loadWorkspace({ id: copyId }), null)
    editor = render()
    assert.equal(editor.workspace.id, replacementId)

    editor.setMeta({ samples: [{ id: 'detail' }], primary_sample_id: 'detail' })
    assert.ok(await editor.flush())
    assert.ok(await editor.cachePreview('detail', new Blob(['detail preview'])))
    const failingCopyId = crypto.randomUUID()
    storage.save = async (...args) => {
      if (args[1].workspace.id === failingCopyId) throw new Error('copy storage denied')
      return save(...args)
    }
    assert.equal(await editor.duplicateProject({ id: failingCopyId }), null)
    editor = render()
    assert.equal(editor.workspace.id, replacementId)
    assert.equal(await storage.load('7', failingCopyId), null)
    assert.equal(await storage.getPreview('7', failingCopyId, 'detail'), null)
    assert.equal(await (await storage.getPreview('7', replacementId, 'detail')).blob.text(), 'detail preview')
    storage.save = save
    assert.equal(await editor.duplicateProject({ id: sourceId }), null)
    assert.ok(await storage.load('7', sourceId))
    const previewOnlyId = crypto.randomUUID()
    await storage.putPreview('7', previewOnlyId, 'unrelated', new Blob(['existing cache']))
    assert.equal(await editor.duplicateProject({ id: previewOnlyId }), null)
    assert.equal(await (await storage.getPreview('7', previewOnlyId, 'unrelated')).blob.text(), 'existing cache')

    harness.unmount()
    const channels = new Set(), broadcasts = []
    globalThis.BroadcastChannel = class {
      constructor(name) { this.name = name; channels.add(this) }
      postMessage(data) {
        broadcasts.push(data)
        for (const other of channels) if (other !== this && other.name === this.name) other.onmessage?.({ data })
      }
      close() { channels.delete(this) }
    }
    const sharedStorage = createMemoryDraftStorage(), sharedJobs = createMemoryAutoJobStorage()
    const lastProject = createWorkspaceState({ userId: '7', name: '最后的项目' })
    await sharedStorage.save('7', serializeWorkspaceState(lastProject))
    const firstTab = createHarness(), secondTab = createHarness()
    additionalHarnesses.push(firstTab, secondTab)
    const sharedProps = { userId: '7', storage: sharedStorage, jobStorage: sharedJobs }
    const renderFirst = () => firstTab.render(() => useWorkspace(sharedProps))
    const renderSecond = () => secondTab.render(() => useWorkspace(sharedProps))
    renderFirst(); renderSecond()
    await new Promise(resolve => setImmediate(resolve))
    let firstEditor = renderFirst(), secondEditor = renderSecond()
    assert.equal(firstEditor.workspace.id, lastProject.workspace.id)
    assert.equal(secondEditor.workspace.id, lastProject.workspace.id)
    assert.equal(await firstEditor.retireProject(lastProject.workspace.id, { broadcast: false }), true)
    assert.equal(broadcasts.filter(message => message.deleted).length, 0)
    assert.equal(renderSecond().workspace.id, lastProject.workspace.id)
    const sharedReplacementId = crypto.randomUUID()
    assert.ok(await firstEditor.loadWorkspace({ id: sharedReplacementId, name: '同一个替代项目' }))
    firstEditor = renderFirst()
    assert.ok(await firstEditor.flush())
    firstEditor.notifyProjectDeletion(lastProject.workspace.id, sharedReplacementId)
    await new Promise(resolve => setImmediate(resolve))
    secondEditor = renderSecond()
    assert.equal(secondEditor.workspace.id, sharedReplacementId)
    assert.equal(secondEditor.workspace.name, '同一个替代项目')
    assert.equal(secondEditor.ready, true)
    assert.equal((await sharedStorage.list('7')).length, 1)
    assert.equal(broadcasts.filter(message => message.deleted).length, 1)
    firstEditor.notifyProjectDeletion(lastProject.workspace.id, sharedReplacementId)
    await new Promise(resolve => setImmediate(resolve))
    secondEditor = renderSecond()
    assert.equal(secondEditor.workspace.id, sharedReplacementId)
    assert.equal(secondEditor.ready, true)
    assert.equal((await sharedStorage.list('7')).length, 1)
  } finally {
    harness?.unmount()
    for (const additional of additionalHarnesses) additional.unmount()
    globalThis.BroadcastChannel = originalBroadcast
    await rm(directory, { recursive: true, force: true })
  }
})
