import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { effectiveSubjectProtection, MAX_SUBJECT_REGIONS, normalizeSubjectDetection,
  normalizeSubjectRegions, regionFromPoints, regionProtectionText, subjectSelection,
  subjectStatusText } from '../src/lib/subjectAnalysis.js'
import { editingContextForSample } from '../src/lib/samples.js'
import { analyzePhotoSubjects } from '../src/lib/api.js'

const region = { bounds: [.2, .15, .4, .45], kind: 'face', confidence: .93 }
const analysis = overrides => ({ version: 'subject-regions-1', status: 'resolved', subject_mode: 'portrait',
  confidence: .95, regions: [structuredClone(region)], source: 'auto', reason: 'visible_person',
  mask_mode: 'skin_candidates', source_digest: 'photo-a', input_style: 'STD', ...overrides })
const sample = overrides => ({ id: 'main', name: 'Portrait.jpg', source_digest: 'photo-a',
  input_contract: { base_photo_style: 'STD' }, subject_selection: 'auto', subject_detection: analysis(), ...overrides })

test('new and legacy photo selections preserve explicit user decisions', () => {
  assert.equal(subjectSelection({}), 'auto')
  assert.equal(subjectSelection({ subject_mode: 'unknown' }), 'auto')
  assert.equal(subjectSelection({ subject_mode: 'portrait' }), 'portrait')
  assert.equal(subjectSelection({ subject_mode: 'non_portrait' }), 'non_portrait')
  assert.equal(subjectSelection({ subject_selection: 'auto', subject_mode: 'portrait' }), 'auto')
  assert.equal(subjectSelection({ subject_selection: 'toString' }), 'auto')
})

test('analysis is reusable only for the same source bytes and normalized input style', () => {
  assert.ok(normalizeSubjectDetection(analysis(), 'photo-a', 'STD'))
  assert.equal(normalizeSubjectDetection(analysis(), 'photo-b', 'STD'), null)
  assert.equal(normalizeSubjectDetection(analysis(), 'photo-a', 'VLOG'), null)
  assert.equal(normalizeSubjectDetection(analysis({ source_digest: undefined }), 'photo-a'), null)
  assert.equal(normalizeSubjectDetection(analysis({ input_style: undefined }), 'photo-a', 'STD'), null)
  for (const invalid of [null, {}, analysis({ version: 'future' }), analysis({ confidence: NaN }), analysis({ subject_mode: 'landscape' }),
    analysis({ confidence: .7 }), analysis({ subject_mode: 'unknown' }), analysis({ status: 'failed' }),
    analysis({ status: 'loading' }), analysis({ regions: [region, { ...region, bounds: [0, 0, 1, Infinity] }] }),
    analysis({ regions: Array.from({ length: MAX_SUBJECT_REGIONS + 1 }, () => region) })]) {
    assert.equal(normalizeSubjectDetection(invalid), null)
  }
})

test('warm background with no detected people never gets a face color region', () => {
  const result = effectiveSubjectProtection(sample({ subject_detection: analysis({ subject_mode: 'non_portrait', regions: [] }) }))
  assert.equal(result.subject_mode, 'non_portrait')
  assert.deepEqual(result.regions, [])
  assert.equal(result.enabled, false)
  assert.match(subjectStatusText(sample({ subject_detection: analysis({ subject_mode: 'non_portrait', regions: [] }) })), /自动识别：无人物/)
})

test('uncertain, failed, disabled and stale analyses do not enable protection', () => {
  for (const status of ['uncertain', 'failed', 'disabled']) {
    const value = sample({ subject_detection: analysis({ status }) })
    const result = effectiveSubjectProtection(value)
    assert.equal(result.subject_mode, 'unknown')
    assert.equal(result.enabled, false)
    assert.deepEqual(result.regions, [])
  }
  const stale = effectiveSubjectProtection(sample({ source_digest: 'changed-photo' }))
  assert.equal(stale.detection, null)
  assert.equal(stale.enabled, false)
  assert.equal(stale.status, 'idle')
})

test('regions below the backend confidence threshold never claim protection', () => {
  const value = sample({ subject_detection: analysis({ regions: [{ ...region, confidence: .7 }] }) })
  assert.equal(effectiveSubjectProtection(value).enabled, false)
  assert.deepEqual(effectiveSubjectProtection(value).regions, [])
  assert.equal(effectiveSubjectProtection(sample({ subject_regions: [{ ...region, confidence: .7 }] })).enabled, false)
})

test('resolved portrait with no located skin does not imply active protection', () => {
  const value = sample({ subject_detection: analysis({ regions: [] }) })
  assert.equal(effectiveSubjectProtection(value).subject_mode, 'portrait')
  assert.equal(effectiveSubjectProtection(value).enabled, false)
  assert.match(regionProtectionText(value), /尚无可用保护区域/)
})

test('manual no-person override wins over automatic portrait', () => {
  const result = effectiveSubjectProtection(sample({ subject_selection: 'non_portrait', subject_regions: [region] }))
  assert.equal(result.subject_mode, 'non_portrait')
  assert.deepEqual(result.regions, [])
  assert.equal(result.enabled, false)
})

test('cleared manual regions stay empty until explicitly restored to automatic regions', () => {
  const cleared = sample({ subject_regions: [] })
  assert.equal(effectiveSubjectProtection(cleared).enabled, false)
  assert.deepEqual(effectiveSubjectProtection(cleared).regions, [])
  const restored = effectiveSubjectProtection({ ...cleared, subject_regions: null })
  assert.equal(restored.enabled, true)
  assert.deepEqual(restored.regions, [region])
})

test('all-pixel protection is restricted to explicit manual regions', () => {
  assert.equal(effectiveSubjectProtection(sample({ subject_region_mask_mode: 'all_pixels' })).mask_mode, 'skin_candidates')
  const manual = effectiveSubjectProtection(sample({ subject_regions: [region], subject_region_mask_mode: 'all_pixels' }))
  assert.equal(manual.mask_mode, 'all_pixels')
  assert.equal(manual.source, 'manual')
  assert.equal(normalizeSubjectDetection(analysis({ mask_mode: 'all_pixels' })), null)
})

test('manual confirmation without detection needs a region instead of reverting to the whole photo', () => {
  const value = sample({ subject_selection: 'portrait', subject_detection: null })
  assert.equal(effectiveSubjectProtection(value).enabled, false)
  assert.deepEqual(effectiveSubjectProtection(value).regions, [])
  const marked = effectiveSubjectProtection({ ...value, subject_regions: [region] })
  assert.equal(marked.enabled, true)
})

test('photo contexts carry a detached analysis and distinguish inherited, cleared and corrected regions', () => {
  const workspace = { goal_mode: 'natural', locked_fields: ['temp'] }
  const source = sample()
  const inherited = editingContextForSample(workspace, source)
  assert.equal(inherited.subject_mode, 'portrait')
  assert.equal(inherited.subject_detection_mode, 'auto')
  assert.equal(inherited.skin_regions, null)
  assert.equal(inherited.subject_analysis.source_digest, 'photo-a')
  const cleared = editingContextForSample(workspace, sample({ subject_regions: [] }))
  assert.deepEqual(cleared.skin_regions, [])
  const corrected = editingContextForSample(workspace, sample({ subject_selection: 'portrait',
    subject_regions: [region], subject_region_mask_mode: 'all_pixels' }))
  assert.equal(corrected.subject_detection_mode, 'manual')
  assert.equal(corrected.skin_mask_mode, 'all_pixels')
  assert.deepEqual(corrected.skin_regions, [region])
  inherited.subject_analysis.regions[0].bounds[0] = .01
  inherited.locked_fields.push('tint')
  assert.equal(source.subject_detection.regions[0].bounds[0], .2)
  assert.deepEqual(workspace.locked_fields, ['temp'])
})

test('recognition multipart sends the original photo with the current display conversion and source binding', async t => {
  const params = { base_photo_style: 'VLOG', tone_map: .65, external_lut_id: 'input-lut', external_lut_mode: 'input' }
  const file = new Blob(['source bytes'], { type: 'image/jpeg' })
  let request
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options }
    return new Response(JSON.stringify(analysis()), { status: 200 })
  })
  assert.deepEqual(await analyzePhotoSubjects({ file, params, source_digest: 'photo-a', enabled: true }), analysis())
  assert.equal(request.url, '/api/photos/subjects')
  assert.equal(request.credentials, 'include')
  assert.equal(request.method, 'POST')
  assert.equal(await request.body.get('file').text(), 'source bytes')
  assert.equal(request.body.get('input_style'), 'VLOG')
  assert.equal(request.body.get('tone_map'), '0.65')
  assert.deepEqual(JSON.parse(request.body.get('params')), params)
  assert.equal(request.body.get('source_digest'), 'photo-a')
  assert.equal(request.body.get('enabled'), 'true')
  assert.equal(request.headers, undefined)
})

test('region validation rejects malformed boxes and returns detached copies', () => {
  for (const bounds of [[0, 0, 0, 1], [0, 1, 1, 0], [-.1, 0, 1, 1], [0, 0, 1.1, 1], [0, 0, 1, NaN], [0, 0, 1]]) {
    assert.deepEqual(normalizeSubjectRegions([{ ...region, bounds }]), [])
  }
  assert.deepEqual(normalizeSubjectRegions([{ ...region, kind: 'tree' }]), [])
  assert.deepEqual(normalizeSubjectRegions([{ ...region, confidence: '.9' }]), [])
  const frozen = structuredClone(region)
  const copied = normalizeSubjectRegions([region])
  copied[0].bounds[0] = .1
  assert.deepEqual(region, frozen)
  assert.equal(normalizeSubjectRegions(Array.from({ length: 30 }, () => region)).length, MAX_SUBJECT_REGIONS)
})

test('drawing accepts either direction and ignores an accidental click', () => {
  assert.deepEqual(regionFromPoints([.7, .8], [.2, .3]), { bounds: [.2, .3, .7, .8], kind: 'exposed_skin', confidence: 1 })
  assert.equal(regionFromPoints([.2, .3], [.2, .3]), null)
  assert.equal(regionFromPoints([.2, .3], [NaN, .4]), null)
  assert.equal(regionFromPoints([.2, .3], [1.1, .4]), null)
})

const require = createRequire(import.meta.url)
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/components/SubjectProtectionPanel.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' },
  plugins: [{ name: 'plain-controls', setup(builder) {
    builder.onResolve({ filter: /(?:SelectField|CheckboxField)\.jsx$/ }, args => ({ path: args.path, namespace: 'plain-controls' }))
    builder.onLoad({ filter: /.*/, namespace: 'plain-controls' }, args => ({ contents: args.path.endsWith('SelectField.jsx')
      ? `import {createElement} from 'react'; export default function Control(props) { return createElement('select', props, props.children) }`
      : `import {createElement} from 'react'; export default function Control({checked, ...props}) { return createElement('input', {...props, type:'checkbox', checked}) }` }))
  } }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports)
const Panel = module.exports.default
const render = value => renderToStaticMarkup(createElement(Panel, { sample: value, previewUrl: 'local-preview',
  onDetect() {}, onSelectionChange() {}, onRegionsChange() {}, onMaskModeChange() {} }))

test('panel defaults to automatic recognition and gives a keyboard path for region editing', () => {
  const html = render(sample())
  assert.match(html, /value="auto" selected=""/)
  assert.match(html, /自动识别：包含人物/)
  assert.match(html, /1 个区域参与肤色保护检查/)
  assert.match(html, /用数值添加区域/)
  for (const edge of ['左边界', '上边界', '右边界', '下边界']) assert.match(html, new RegExp(`aria-label="保护区域 1 ${edge}百分比"`))
  assert.match(html, /LUT 仍对整张照片调色/)
  assert.match(html, /class="subject-protection-details" hidden=""/)
  assert.doesNotMatch(html, /框内全部像素参与保护/)
})

test('panel reports failure and preserves the manual correction entrance', () => {
  const html = render(sample({ subject_detection: analysis({ status: 'failed', subject_mode: 'unknown', regions: [] }) }))
  assert.match(html, /自动识别未完成/)
  assert.match(html, /可重试识别，或将照片内容改为人工确认/)
  assert.match(html, /包含人物（人工修正）/)
  assert.doesNotMatch(html, /\d+ 个区域参与肤色保护检查/)
})

test('panel exposes all-pixel control only after manual region correction and disables controls during detection', () => {
  const html = render(sample({ subject_regions: [region], subject_region_mask_mode: 'all_pixels' }))
  assert.match(html, /框内全部像素参与保护/)
  assert.match(html, /恢复自动区域/)
  assert.match(html, /checked=""/)
  const loading = renderToStaticMarkup(createElement(Panel, { sample: sample(), detecting: true,
    onDetect() {}, onSelectionChange() {}, onRegionsChange() {} }))
  assert.match(loading, /正在识别人像与肤色区域/)
  assert.match(loading, /人物识别方式" disabled=""/)
  assert.match(loading, /识别中…/)
})
