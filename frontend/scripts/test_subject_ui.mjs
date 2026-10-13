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
  const componentPath = fileURLToPath(new URL(`../src/components/${filename}`, import.meta.url))
  const entry = filename === 'SampleGallery.jsx' ? { stdin: {
    contents: `import {createElement} from 'react'; import Component from './SampleGallery.jsx'; import {DialogProvider} from './ui/Dialog.jsx'; export default function Gallery(props) { return createElement(DialogProvider, null, createElement(Component, props)) }`,
    resolveDir: fileURLToPath(new URL('../src/components/', import.meta.url)), sourcefile: 'gallery-with-dialogs.jsx', loader: 'jsx',
  } } : { entryPoints: [componentPath] }
  const bundled = await build({ ...entry,
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

function findElement(element, predicate) {
  if (!element?.props) return null
  if (predicate(element)) return element
  return [element.props.children].flat(Infinity).map(child => findElement(child, predicate)).find(Boolean)
}

const recoveryButton = (tree, label) => findElement(tree, element => element.type === 'button' && element.props.children === label)

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

test('header mode keeps editing controls without duplicating draft recovery', () => {
  for (const state of [{ error: new Error('保存服务不可用'), saveStatus: 'unsaved' }, { conflict: true, saveStatus: 'conflict' }]) {
    const html = render(Toolbar, { mode: 'header', editor: { workspace, ...state }, onBackup() {} })
    assert.match(html, /draft-status/)
    assert.match(html, /撤销/)
    assert.match(html, /新建调色项目/)
    assert.doesNotMatch(html, /role="alert"|保存服务不可用|重试保存|另存本机副本|下载参数备份/)
  }
})

test('recovery mode leaves no empty region when the draft has no error or conflict', () => {
  const props = { mode: 'recovery', editor: { workspace, saveStatus: 'saved', error: null, conflict: null } }
  assert.equal(Toolbar(props), null)
  assert.equal(render(Toolbar, props), '')
})

test('draft error recovery retries saving and retains the backup entry', () => {
  let saves = 0
  let forks = 0
  let backups = 0
  const props = { mode: 'recovery', editor: { workspace, error: new Error('保存服务不可用'),
    flush: () => { saves++ }, fork: () => { forks++ } }, onBackup: () => { backups++ } }
  const html = render(Toolbar, props)
  assert.match(html, /role="alert"/)
  assert.match(html, /保存服务不可用/)
  assert.match(html, /重试保存/)
  assert.match(html, /下载参数备份/)
  assert.doesNotMatch(html, /另存本机副本|draft-status|新建调色项目|创作目标/)
  const tree = Toolbar(props)
  recoveryButton(tree, '重试保存').props.onClick()
  recoveryButton(tree, '下载参数备份').props.onClick()
  assert.deepEqual({ saves, forks, backups }, { saves: 1, forks: 0, backups: 1 })
})

test('draft conflict recovery forks instead of overwriting and retains backup access', () => {
  let saves = 0
  let forks = 0
  let backups = 0
  const editor = { workspace, conflict: true, flush: () => { saves++ }, fork: () => { forks++ } }
  const props = { mode: 'recovery', editor, onBackup: () => { backups++ } }
  const html = render(Toolbar, props)
  assert.match(html, /role="alert"/)
  assert.match(html, /检测到其他标签页的更新，已暂停覆盖/)
  assert.match(html, /另存本机副本/)
  assert.match(html, /下载参数备份/)
  assert.doesNotMatch(html, /重试保存|draft-status|新建调色项目|创作目标/)
  const tree = Toolbar(props)
  recoveryButton(tree, '另存本机副本').props.onClick()
  recoveryButton(tree, '下载参数备份').props.onClick()
  const both = Toolbar({ ...props, editor: { ...editor, error: new Error('同时存在保存错误') } })
  recoveryButton(both, '另存本机副本').props.onClick()
  assert.deepEqual({ saves, forks, backups }, { saves: 0, forks: 2, backups: 1 })
})

test('busy recovery disables retry and fork execution while preserving a readable alert', () => {
  for (const [state, label] of [[{ error: new Error('保存服务不可用') }, '重试保存'], [{ conflict: true }, '另存本机副本']]) {
    const props = { mode: 'recovery', busy: true, editor: { workspace, ...state }, onBackup() {} }
    const tree = Toolbar(props)
    assert.equal(recoveryButton(tree, label).props.disabled, true)
    assert.match(render(Toolbar, props), /role="alert"/)
    assert.match(render(Toolbar, props), new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`))
  }
})

test('full toolbar retains context, editing and draft recovery for existing callers', () => {
  for (const [state, label] of [[{ error: new Error('保存服务不可用') }, '重试保存'], [{ conflict: true }, '另存本机副本']]) {
    const html = render(Toolbar, { editor: { workspace, saveStatus: 'unsaved', ...state }, onBackup() {} })
    assert.match(html, /创作目标/)
    assert.match(html, /draft-status/)
    assert.match(html, /新建调色项目/)
    assert.match(html, /role="alert"/)
    assert.match(html, new RegExp(label))
    assert.match(html, /下载参数备份/)
  }
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

test('localized report accurately labels automatic recognition and measured protection', () => {
  const html = render(Report, { result: { params: defaultParams(), context: workspace,
    subject_protection: { subject_mode: 'portrait', enabled: true, source: 'auto',
      suspected_skin_ratio: .01, method: 'localized_regions' } } })
  assert.match(html, /自动识别/)
  assert.match(html, /已启用 · 已定位区域/)
  assert.match(html, /可人工修正/)
  assert.doesNotMatch(html, /没有人物检测/)
  assert.doesNotMatch(html, /用户标注|人工确认/)
})

test('gallery keeps distinct photo annotations and allows the selected validation photo to be marked', () => {
  const other = { ...sample, id: 'other', name: 'Person.jpg', subject_mode: 'portrait' }
  const html = render(Gallery, { samples: [sample, other], media: new Map(), selectedId: 's', primaryId: 'other',
    busy: true, onSubjectChange() {} })
  assert.match(html, /人工确认：无人物/)
  assert.match(html, /人工确认：包含人物/)
  assert.match(html, /aria-label="Tree.jpg 照片内容"[^>]*disabled=""/)
  assert.match(html, /value="non_portrait" selected=""/)
})
