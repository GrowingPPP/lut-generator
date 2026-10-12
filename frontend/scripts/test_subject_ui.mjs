import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaultParams } from '../src/lib/lutEngine.js'

const require = createRequire(import.meta.url)
async function loadComponent(filename) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(`../src/components/${filename}`, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    loader: { '.css': 'empty' }, plugins: [{ name: 'plain-controls', setup(builder) {
      builder.onResolve({ filter: /(?:SelectField|Tooltip|CheckboxField)\.jsx$/ }, args => ({ path: args.path, namespace: 'plain-controls' }))
      builder.onLoad({ filter: /.*/, namespace: 'plain-controls' }, args => ({
        contents: args.path.endsWith('Tooltip.jsx')
          ? 'export default function Tooltip({children}) { return children }'
          : `import {createElement} from 'react'; export default function Control(props) { return createElement('${args.path.endsWith('SelectField.jsx') ? 'select' : 'input'}', props, props.children) }`,
      }))
    } }] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports)
  return module.exports.default
}
const [Toolbar, Report, Gallery] = await Promise.all(['WorkspaceToolbar.jsx', 'AutoRetouchReport.jsx', 'SampleGallery.jsx'].map(loadComponent))
const render = (component, props) => renderToStaticMarkup(createElement(component, props))
const workspace = { goal_mode: 'preserve', locked_fields: [] }
const sample = { id: 's', name: 'Tree.jpg', subject_mode: 'non_portrait', input_contract: { base_photo_style: 'STD' } }

test('toolbar identifies the AI primary photo and hides its annotation without an optional callback', () => {
  const props = { editor: { workspace }, sample: { metadata: sample }, mode: 'context', onSubjectChange() {} }
  const html = render(Toolbar, props)
  assert.match(html, /AI 主样张照片内容/)
  assert.match(html, /Tree.jpg/)
  assert.match(html, /value="non_portrait" selected=""/)
  assert.match(html, /只用于这张样张/)
  assert.doesNotMatch(render(Toolbar, { ...props, onSubjectChange: undefined }), /照片内容/)
  assert.doesNotMatch(render(Toolbar, { ...props, mode: 'header' }), /照片内容/)
})

test('toolbar sends only the selected mode to the supplied primary-photo callback', () => {
  let selected
  const tree = Toolbar({ editor: { workspace }, sample, busy: true, mode: 'context', onSubjectChange: mode => { selected = mode } })
  function findControl(element) {
    if (!element?.props) return null
    if (element.props['aria-label'] === 'AI 主样张照片内容') return element
    return [element.props.children].flat(Infinity).map(findControl).find(Boolean)
  }
  const control = findControl(tree)
  assert.equal(control.props.disabled, true)
  control.props.onChange({ target: { value: 'portrait' } })
  assert.equal(selected, 'portrait')
})

test('report uses formal protection evidence over a different context and explains its color-only scope', () => {
  const result = { params: defaultParams(), context: { ...workspace, subject_mode: 'non_portrait' },
    subject_protection: { subject_mode: 'portrait', enabled: true, suspected_skin_ratio: .32, method: 'color_heuristic' } }
  const html = render(Report, { result })
  assert.match(html, /当次照片内容/)
  assert.match(html, /包含人物/)
  assert.match(html, /已启用/)
  assert.match(html, /疑似肤色/)
  assert.match(html, /32\.0%/)
  assert.match(html, /没有人物检测或分割/)
  assert.doesNotMatch(html, />无人物</)
})

test('old report annotation remains unrecorded while unknown does not claim protection', () => {
  const old = render(Report, { result: { params: defaultParams(), context: workspace } })
  assert.match(old, /当次照片内容/)
  assert.doesNotMatch(old, /已启用/)
  const unknown = render(Report, { result: { params: defaultParams(), context: { ...workspace, subject_mode: 'unknown' } } })
  assert.match(unknown, /未确认/)
  assert.doesNotMatch(unknown, /已启用/)
})

test('gallery keeps distinct photo annotations and allows the selected validation photo to be marked', () => {
  const other = { ...sample, id: 'other', name: 'Person.jpg', subject_mode: 'portrait' }
  const html = render(Gallery, { samples: [sample, other], media: new Map(), selectedId: 's', primaryId: 'other',
    busy: true, onSubjectChange() {} })
  assert.match(html, /照片内容：无人物/)
  assert.match(html, /照片内容：包含人物/)
  assert.match(html, /aria-label="Tree.jpg 照片内容"[^>]*disabled=""/)
  assert.match(html, /value="non_portrait" selected=""/)
})
