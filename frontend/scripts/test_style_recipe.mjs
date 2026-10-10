import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams } from '../src/lib/lutEngine.js'
import { createWorkspaceState, commitEdit, undoEdit } from '../src/lib/workspace.js'
import { buildStyleRecipe, applyStyleRecipe, inputContract, recordStyleContribution,
  createProjection, validateRecipe, recipeCanSave, resetProjection, wrapHue } from '../src/lib/styleRecipe.js'

test('same-field correction/style/correction preserves only the effective style delta', () => {
  let state = createWorkspaceState()
  state = commitEdit(state, { temp: 600 }, { purpose: 'correction' })
  state = commitEdit(state, { temp: 900 }, { purpose: 'style' })
  state = commitEdit(state, { temp: 500 }, { purpose: 'correction' })
  const recipe = buildStyleRecipe(state.workspace)
  assert.deepEqual(recipe.operations.temp, { mode: 'add', value: 300 })
  assert.equal(recipe.source.corrections_after_style, true)
  assert.equal(applyStyleRecipe(recipe, { ...defaultParams(), temp: -400 }).temp, -100)
  assert.equal(state.workspace.params.temp, 500)
  assert.equal(undoEdit(state).workspace.params.temp, 900)
})

test('unchanged anchors and creative strength are captured, arrays use channel deltas', () => {
  let state = createWorkspaceState({ initialParams: { ...defaultParams(), contrast_pivot: 0.6 } })
  state = commitEdit(state, { contrast: 0.2, gamma: [1.1, 0.9, 1] }, { purpose: 'style' })
  const recipe = buildStyleRecipe(state.workspace)
  assert.deepEqual(recipe.operations.contrast_pivot, { mode: 'set', value: 0.6, dependency: true })
  assert.deepEqual(recipe.operations.look_strength, { mode: 'set', value: 1, dependency: true })
  assert.ok(Math.abs(recipe.operations.gamma.value[0] - 0.1) < 1e-12)
  const applied = applyStyleRecipe(recipe, { ...defaultParams(), gamma: [0.8, 1.2, 1], look_strength: 0.2 })
  assert.ok(Math.abs(applied.gamma[0] - 0.9) < 1e-12)
  assert.equal(applied.look_strength, 1)
})

test('add/set composition and circular hue retain their specified semantics', () => {
  const base = defaultParams()
  let projection = createProjection(base)
  projection = recordStyleContribution(projection, base, { ...base, temp: 300 })
  projection = recordStyleContribution(projection, { ...base, temp: 300 }, { ...base, temp: 400 }, { modes: { temp: 'set' } })
  projection = recordStyleContribution(projection, { ...base, temp: 400 }, { ...base, temp: 450 })
  assert.deepEqual(projection.operations.temp, { mode: 'set', value: 450 })
  const hue = recordStyleContribution(createProjection({ ...base, hue: 170 }), { ...base, hue: 170 }, { ...base, hue: -170 })
  assert.equal(hue.operations.hue.value, 20)
  assert.equal(applyStyleRecipe({ format_version: 1, kind: 'portable_style', input_contract: inputContract(base), operations: hue.operations }, { ...base, hue: 175 }).hue, -165)
})

test('resetting an effect removes unused dependencies while resetting an anchor reanchors retained effects', () => {
  const base = { ...defaultParams(), contrast_pivot: 0.6 }
  const projection = recordStyleContribution(createProjection(base), base, { ...base, contrast: 0.2 })
  const effectReset = resetProjection(projection, ['contrast'], defaultParams())
  assert.deepEqual(effectReset.operations, {})
  const anchorReset = resetProjection(projection, ['contrast_pivot'], { ...defaultParams(), contrast: 0.2 })
  assert.equal(anchorReset.operations.contrast_pivot.value, defaultParams().contrast_pivot)
  assert.equal(anchorReset.operations.contrast.value, 0.2)
})

test('recipe rejects technical fields, missing anchors, locks and absolute result overflow without clipping', () => {
  let state = createWorkspaceState()
  state = commitEdit(state, { contrast: 0.5 }, { purpose: 'style' })
  const recipe = buildStyleRecipe(state.workspace)
  assert.throws(() => applyStyleRecipe(recipe, { ...defaultParams(), contrast: 0.8 }), { code: 'invalid_params' })
  assert.throws(() => applyStyleRecipe(recipe, defaultParams(), { lockedFields: ['contrast'] }), { code: 'locked_fields' })
  assert.throws(() => validateRecipe({ ...recipe, operations: { contrast: recipe.operations.contrast } }), { code: 'invalid_recipe' })
  assert.throws(() => validateRecipe({ ...recipe, operations: { ...recipe.operations, tone_map: { mode: 'set', value: 1 } } }), { code: 'invalid_recipe' })
  assert.throws(() => applyStyleRecipe(recipe, { ...defaultParams(), base_photo_style: 'NAT' }), { code: 'input_mismatch' })
})

test('unknown baseline requires explicit selection and technical switch requires reconfirmation', () => {
  let state = createWorkspaceState({ params: { ...defaultParams(), temp: 300 }, legacy: true })
  state = commitEdit(state, { contrast: 0.2 }, { purpose: 'style' })
  assert.equal(recipeCanSave(state.workspace).allowed, false)
  state = commitEdit(state, null, { confirmBaselineFields: ['temp'] })
  assert.equal(recipeCanSave(state.workspace).allowed, true)
  assert.equal(buildStyleRecipe(state.workspace).operations.temp.mode, 'set')
  state = commitEdit(state, { base_photo_style: 'NAT' })
  assert.equal(state.workspace.recipe_projection.input_contract.base_photo_style, 'STD')
  assert.equal(recipeCanSave(state.workspace).allowed, false)
  state = commitEdit(state, null, { confirmInput: true })
  assert.equal(buildStyleRecipe(state.workspace).input_contract.base_photo_style, 'NAT')
})

test('negative gamma increments are legal when the resulting absolute target is legal', () => {
  const params = defaultParams()
  const recipe = { format_version: 1, kind: 'portable_style', input_contract: inputContract(params), operations: {
    gamma: { mode: 'add', value: [-0.2, -0.1, 0] }, look_strength: { mode: 'set', value: 1, dependency: true },
  } }
  assert.deepEqual(applyStyleRecipe(recipe, params).gamma, [0.8, 0.9, 1])
})

test('input contracts match by values regardless of JSON key ordering', () => {
  const state = commitEdit(createWorkspaceState(), { temp: 100 }, { purpose: 'style' })
  const recipe = buildStyleRecipe(state.workspace)
  recipe.input_contract = { tone_map: 1, output_encoding: 'sRGB', base_photo_style: 'STD' }
  assert.equal(applyStyleRecipe(recipe, defaultParams()).temp, 100)
})

test('explicit baseline confirmation can retain a neutral fixed target and uses the actual anchors', () => {
  let state = createWorkspaceState({ params: { ...defaultParams(), contrast: 0.1, contrast_pivot: 0.7, look_strength: 0.8 }, legacy: true })
  state = commitEdit(state, null, { confirmBaselineFields: ['temp', 'contrast'] })
  const recipe = buildStyleRecipe(state.workspace)
  assert.deepEqual(recipe.operations.temp, { mode: 'set', value: 0 })
  assert.equal(recipe.operations.contrast_pivot.value, 0.7)
  assert.equal(recipe.operations.look_strength.value, 0.8)
})

test('hue normalization matches Python arithmetic for small increments and negative boundaries', () => {
  assert.equal(wrapHue(0.1), 0.09999999999999432)
  assert.equal(wrapHue(-180), -180)
  assert.equal(wrapHue(180), -180)
  assert.equal(wrapHue(-180.1), 179.89999999999998)
  assert.equal(wrapHue(-540), -180)
})

test('a color change cannot be mislabeled as an unrelated dependency anchor', () => {
  const state = commitEdit(createWorkspaceState(), { contrast: 0.1 }, { purpose: 'style' })
  const recipe = buildStyleRecipe(state.workspace)
  recipe.operations.temp = { mode: 'set', value: 3000, dependency: true }
  assert.throws(() => validateRecipe(recipe), (error) => error.code === 'invalid_dependency' && error.fields.includes('temp'))
})

test('format aliases must agree and explicit null markers cannot use defaults', () => {
  const state = commitEdit(createWorkspaceState(), { temp: 100 }, { purpose: 'style' })
  const recipe = buildStyleRecipe(state.workspace)
  const { format_version, kind, ...body } = recipe
  assert.equal(validateRecipe({ ...body, schema_version: 1 }).schema_version, 1)
  for (const patch of [
    { schema_version: 2 }, { schema_version: null },
    { format_version: null, schema_version: 1 }, { kind: null },
  ]) assert.throws(() => validateRecipe({ ...recipe, ...patch }), { code: 'invalid_recipe' })
})
