import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  creationToolTab,
  isCreationStep,
  restoredCreationStep,
} from '../src/lib/creationFlow.js'

const require = createRequire(import.meta.url)
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/hooks/useCreationFlow.js', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
})

// Retain hook state between renders while executing the real flow hook and
// migration functions. Only React's state/effect scheduler is substituted.
function flowHost(initialProps) {
  const slots = []
  let cursor = 0
  let pendingEffects = []
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      }]
    },
    useEffect(callback, dependencies) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
        slots[index] = { dependencies }
        pendingEffects.push(callback)
      }
    },
    useCallback(callback, dependencies) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) {
        slots[index] = { callback, dependencies }
      }
      return slots[index].callback
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    name => name === 'react' ? hooks : require(name), module, module.exports,
  )
  let props = initialProps
  return {
    render(next = {}) {
      props = { ...props, ...next }
      cursor = 0
      pendingEffects = []
      const flow = module.exports.default(props)
      for (const effect of pendingEffects) effect()
      return flow
    },
  }
}

const project = (id, rest = {}) => ({ id, params: { contrast: .1 }, ...rest })

function frozenProject(id, rest = {}) {
  return Object.freeze({ ...project(id, rest), params: Object.freeze({ contrast: .1 }),
    samples: Object.freeze(rest.samples || []),
    view_state: Object.freeze(rest.view_state || {}),
  })
}

test('legacy drafts without step preferences enter a useful stage without certifying photos', () => {
  assert.equal(restoredCreationStep(project('empty')), 'photos')
  assert.equal(restoredCreationStep(project('empty-array', { samples: [] })), 'photos')
  assert.equal(restoredCreationStep(project('sample', { samples: [{ id: 's', input_confirmed: false }] })), 'style')
  assert.equal(restoredCreationStep(project('manual', { view_state: { tool_tab: 'manual' } })), 'adjust')
  assert.equal(restoredCreationStep(project('versions', { view_state: { tool_tab: 'versions' } })), 'adjust')
  assert.equal(restoredCreationStep(project('report', { report: { goal_status: 'partial' } })), 'adjust')
  assert.equal(restoredCreationStep(project('ai-only', { view_state: { tool_tab: 'ai' } })), 'photos')
})

test('a valid saved creation step takes priority over legacy report, sample and tool-tab inference', () => {
  for (const step of ['photos', 'style', 'adjust', 'save']) {
    const workspace = frozenProject('persisted', {
      samples: [{ id: 's' }],
      report: { goal_status: 'partial' },
      view_state: { creation_step: step, tool_tab: 'versions' },
    })
    assert.equal(restoredCreationStep(workspace), step)
    assert.equal(workspace.view_state.creation_step, step)
  }
})

test('unknown or malformed saved steps fall back to legacy context rather than a missing screen', () => {
  for (const value of [undefined, null, '', 'bogus', 'SAVE', 3, {}, ['save']]) {
    assert.equal(isCreationStep(value), false)
    assert.equal(restoredCreationStep(project('old', { view_state: { creation_step: value } })), 'photos')
    assert.equal(restoredCreationStep(project('sample', { samples: [{ id: 's' }], view_state: { creation_step: value } })), 'style')
    assert.equal(restoredCreationStep(project('manual', { view_state: { creation_step: value, tool_tab: 'manual' } })), 'adjust')
  }
})

test('step tool mapping keeps version comparison available and limits AI tools to the style stage', () => {
  for (const tab of ['ai', 'manual', 'versions', undefined, 'unknown']) {
    assert.equal(creationToolTab('photos', tab), 'none')
    assert.equal(creationToolTab('style', tab), 'ai')
    assert.equal(creationToolTab('save', tab), 'none')
    assert.equal(creationToolTab('adjust', tab), tab === 'versions' ? 'versions' : 'manual')
  }
})

test('navigation completes the pending adjustment before selecting a stage and never writes formal data', () => {
  const workspace = frozenProject('a', { view_state: { creation_step: 'photos' } })
  const original = JSON.stringify(workspace)
  const observed = []
  let host
  host = flowHost({ workspace, ready: true, beforeNavigate: () => observed.push(host.render().step) })
  assert.equal(host.render().navigate('adjust'), true)
  assert.deepEqual(observed, ['photos'])
  assert.equal(host.render().step, 'adjust')
  assert.equal(host.render().navigate('save'), true)
  assert.deepEqual(observed, ['photos', 'adjust'])
  assert.equal(host.render().step, 'save')
  assert.equal(JSON.stringify(workspace), original)
})

test('not-ready and invalid navigation leave both the selected stage and pending edits untouched', () => {
  let committed = 0
  const host = flowHost({ workspace: project('a', { view_state: { creation_step: 'style' } }),
    ready: false, beforeNavigate: () => { committed++ } })
  assert.equal(host.render().navigate('save'), false)
  assert.equal(host.render().step, 'style')
  for (const invalid of ['', 'unknown', null, undefined, 1, {}]) {
    assert.equal(host.render({ ready: true }).navigate(invalid), false)
    assert.equal(host.render().step, 'style')
  }
  assert.equal(committed, 0)
  assert.equal(host.render().navigate('adjust'), true)
  assert.equal(committed, 1)
  assert.equal(host.render({ ready: false }).navigate('photos'), false)
  assert.equal(host.render().step, 'adjust')
  assert.equal(committed, 1)
})

test('switching projects reads the destination preference and never carries the source stage into it', () => {
  const first = project('a', { view_state: { creation_step: 'photos' } })
  const second = project('b', { view_state: { creation_step: 'style' } })
  const host = flowHost({ workspace: first, ready: true })
  assert.equal(host.render().navigate('save'), true)
  assert.equal(host.render().step, 'save')
  assert.equal(host.render({ workspace: second }).step, 'style')
  assert.equal(host.render().navigate('adjust'), true)
  assert.equal(host.render().step, 'adjust')
  // The project's externally persisted preference is restored when revisiting.
  assert.equal(host.render({ workspace: { ...first, view_state: { creation_step: 'save' } } }).step, 'save')
  assert.equal(host.render({ workspace: project('c') }).step, 'photos')
})

test('parameter and photo updates inside one project preserve its current viewing stage', () => {
  const host = flowHost({ workspace: project('a'), ready: true })
  host.render().navigate('adjust')
  const updated = project('a', { params: { contrast: .3 }, samples: [{ id: 'new-photo' }],
    view_state: { creation_step: 'style' } })
  assert.equal(host.render({ workspace: updated }).step, 'adjust')
  assert.deepEqual(updated.params, { contrast: .3 })
  assert.equal(updated.view_state.creation_step, 'style')
})

test('uploading the first photo and receiving a report do not navigate an untouched active project', () => {
  const host = flowHost({ workspace: project('a'), ready: true })
  assert.equal(host.render().step, 'photos')
  assert.equal(host.render({ workspace: project('a', { samples: [{ id: 'first-photo', input_confirmed: false }] }) }).step, 'photos')
  assert.equal(host.render().step, 'photos')
  assert.equal(host.render({ workspace: project('a', { samples: [{ id: 'first-photo' }], report: { goal_status: 'partial' } }) }).step, 'photos')

  const style = flowHost({ workspace: project('b', { samples: [{ id: 'primary' }] }), ready: true })
  assert.equal(style.render().step, 'style')
  assert.equal(style.render({ workspace: project('b', { samples: [{ id: 'primary' }], report: { goal_status: 'met' } }) }).step, 'style')
})

test('a same-project reload restores its newly loaded view after readiness without reusing the old local step', () => {
  const host = flowHost({ workspace: project('a'), ready: true })
  host.render().navigate('adjust')
  assert.equal(host.render().step, 'adjust')
  host.render({ ready: false })
  const loaded = project('a', { samples: [{ id: 'primary' }], report: { goal_status: 'partial' },
    view_state: { creation_step: 'save', tool_tab: 'manual' } })
  assert.equal(host.render({ ready: true, workspace: loaded }).step, 'save')
  assert.equal(host.render().step, 'save')

  host.render({ ready: false })
  host.render({ ready: true, workspace: project('a', { samples: [{ id: 'primary' }] }) })
  assert.equal(host.render().step, 'style')
})

test('navigation uses the current project and pre-navigation callback after a render change', () => {
  const calls = []
  const host = flowHost({ workspace: project('a'), ready: true,
    beforeNavigate: () => calls.push('old') })
  host.render()
  const current = host.render({ workspace: project('b', { view_state: { creation_step: 'style' } }),
    beforeNavigate: () => calls.push('new') })
  assert.equal(current.navigate('save'), true)
  assert.deepEqual(calls, ['new'])
  assert.equal(host.render().step, 'save')
  assert.equal(host.render({ workspace: project('a') }).step, 'photos')
})

test('external history changes restore a step without editing parameters or reapplying on autosave', () => {
  let commits = 0
  const workspace = frozenProject('a')
  const host = flowHost({ workspace, ready: true, beforeNavigate: () => commits++, externalStep: 'adjust', externalKey: 1 })
  host.render(); assert.equal(host.render().step, 'adjust')
  host.render({ externalStep: 'photos', externalKey: 2 })
  assert.equal(host.render().step, 'photos'); assert.equal(commits, 0)
  host.render().navigate('save')
  assert.equal(host.render({ workspace: { ...workspace, params: { contrast: .4 } } }).step, 'save')
  assert.equal(commits, 1)
})

test('a failed pending-edit commit does not move to another stage', () => {
  const host = flowHost({ workspace: project('a'), ready: true,
    beforeNavigate: () => { throw new Error('pending edit could not be committed') } })
  assert.throws(() => host.render().navigate('style'), /could not be committed/)
  assert.equal(host.render().step, 'photos')
})


test('the actual creation page renders its first frame with real hooks and providers', async () => {
  const result = await build({
    stdin: {
      contents: `import { createElement } from 'react';
        import GenerateView from './GenerateView.jsx';
        import { DialogProvider } from './components/ui/Dialog.jsx';
        import { TooltipProvider } from './components/ui/Tooltip.jsx';
        export default function CreationSmoke() {
          return createElement(DialogProvider, null,
            createElement(TooltipProvider, null,
              createElement(GenerateView, { user: 'qa-creation-smoke' })));
        }`,
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      sourcefile: 'creation-page-smoke.jsx',
      loader: 'jsx',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'import.meta.hot': 'undefined' },
    plugins: [{ name: 'creation-server-boundaries', setup(builder) {
      builder.onResolve({ filter: /\?lazy-url$/ }, args => ({ path: args.path, namespace: 'creation-lazy-url' }))
      builder.onLoad({ filter: /.*/, namespace: 'creation-lazy-url' }, args => ({
        contents: `export default ${JSON.stringify(`/qa-not-loaded/${args.path.split('/').at(-1).replace('?lazy-url', '')}`)}`,
      }))
      // Server rendering has no Canvas. Substitute only the synthetic image
      // factory, keeping all page components, hooks and state expressions real.
      builder.onResolve({ filter: /(?:^|\/)lib\/preview\.js$/ }, args => ({ path: args.path, namespace: 'creation-canvas' }))
      builder.onLoad({ filter: /.*/, namespace: 'creation-canvas' }, () => ({ contents: `
        export const makeTestImage = () => ({ width: 800, height: 560 });
        export const makeThumb = () => '';
      ` }))
    } }],
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  const html = renderToStaticMarkup(React.createElement(module.exports.default))
  assert.match(html, /选照片/)
  assert.match(html, /定风格/)
  assert.match(html, /调效果/)
  assert.match(html, /保存作品/)
  assert.match(html, /调色项目/)
})
