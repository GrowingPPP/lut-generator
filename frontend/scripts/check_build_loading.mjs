import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

// Inspect emitted production artifacts, including transitive static imports.
// Run `npm run build` first; source-level import checks miss Rollup hoisting.
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const manifest = JSON.parse(await readFile(resolve(dist, '.vite/manifest.json'), 'utf8'))
const entries = Object.entries(manifest)
const keyFor = name => {
  const matches = entries.filter(([, chunk]) => chunk.name === name)
  assert.equal(matches.length, 1, `Expected one emitted ${name} chunk`)
  return matches[0][0]
}
const closure = (...roots) => {
  const seen = new Set()
  const visit = key => {
    if (seen.has(key)) return
    assert.ok(manifest[key], `Missing manifest dependency ${key}`)
    seen.add(key)
    for (const dependency of manifest[key].imports || []) visit(dependency)
  }
  roots.forEach(visit)
  return seen
}
const size = async keys => {
  const js = new Set([...keys].map(key => manifest[key].file).filter(file => file.endsWith('.js')))
  const css = new Set([...keys].flatMap(key => manifest[key].css || []))
  const measure = async files => {
    const buffers = await Promise.all([...files].map(file => readFile(resolve(dist, file))))
    return { bytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0),
      gzipBytes: buffers.reduce((sum, buffer) => sum + gzipSync(buffer).length, 0), files: [...files] }
  }
  return { js: await measure(js), css: await measure(css) }
}

const entryKey = entries.find(([key, chunk]) => key === 'index.html' && chunk.isEntry)?.[0]
assert.ok(entryKey, 'Missing application entry')
const initial = closure(entryKey)
const studio = closure(keyFor('StudioView'))
const generate = closure(keyFor('GenerateView'))
const library = closure(keyFor('LibraryView'))
const tools = ['CurveEditor', 'ImportedLutPanel', 'ReferenceMatchDialog', 'PhotoExportDialog', 'PhotoViewer', 'PhotoAdjustments']
for (const name of ['StudioView', 'AuthView', 'GenerateView', 'LibraryView', ...tools]) {
  const key = keyFor(name)
  assert.equal(manifest[key].isDynamicEntry, true, `${name} must remain a dynamic entry`)
  assert.ok(!initial.has(key), `${name} leaked into the landing page dependency graph`)
}
for (const name of ['GenerateView', 'LibraryView', ...tools]) {
  assert.ok(!studio.has(keyFor(name)), `${name} loads before its studio page is opened`)
}
for (const name of tools) {
  assert.ok(!generate.has(keyFor(name)), `${name} loads before the tool is opened`)
}
assert.ok(!library.has(keyFor('GenerateView')), 'Opening the library loads the photo editor')

// The landing page starts the real LUT demo asynchronously after rendering.
// Count it too, rather than reporting only the smaller entry file.
const initialSize = await size(initial)
const landingReady = await size(closure(entryKey, keyFor('lutEngine')))
assert.ok(initialSize.js.bytes < 350_000, `Initial JS budget exceeded: ${initialSize.js.bytes}`)
assert.ok(landingReady.js.bytes < 380_000, `Landing with demo JS budget exceeded: ${landingReady.js.bytes}`)
assert.ok(initialSize.css.bytes < 70_000, `Initial CSS budget exceeded: ${initialSize.css.bytes}`)
for (const [, chunk] of entries.filter(([, chunk]) => chunk.file.endsWith('.js'))) {
  const contents = await readFile(resolve(dist, chunk.file))
  assert.ok(contents.length < 500_000, `${chunk.file} exceeds the per-chunk budget`)
}
console.log(JSON.stringify({ baseline: { jsBytes: 612_107, gzipBytes: 202_780 },
  initial: initialSize, landingWithDemo: landingReady,
  landingJsReductionPercent: Number(((1 - landingReady.js.bytes / 612_107) * 100).toFixed(1)),
  deferredTools: tools, passed: true }, null, 2))
