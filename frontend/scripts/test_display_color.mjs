import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { displayComponent, displayImageData } from '../src/lib/displayColor.js'
import { defaultParams } from '../src/lib/lutEngine.js'
import { measureDiagnostics, renderDiagnosticPixels } from '../src/lib/diagnostics.js'

test('Rec709 display transfer matches the canonical photo export conversion at dense code values', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const code = `import json,sys,numpy as np\nsys.path.insert(0,'backend')\nfrom photo.color_management import display_rgb\nv=np.linspace(0,1,1001,dtype=np.float32)\nprint(json.dumps(display_rgb(v,'VLOG').tolist()))`
  const process = spawnSync(`${root}.venv/bin/python`, ['-c', code], { cwd: root, encoding: 'utf8' })
  assert.equal(process.status, 0, process.stderr)
  const expected = JSON.parse(process.stdout)
  let previous = -1
  for (let i = 0; i < expected.length; i++) {
    const actual = displayComponent(i / 1000, 'VLOG')
    assert.ok(Math.abs(actual - expected[i]) < 2e-7, `display value ${i}`)
    assert.ok(actual >= previous - 1e-4)
    previous = actual
  }
  assert.equal(displayComponent(0, 'VLOG'), 0)
  assert.ok(Math.abs(displayComponent(1, 'VLOG') - 1) < 1e-10)
})

test('ordinary display pixels and alpha stay unchanged while log display changes only RGB', () => {
  const data = { data: new Uint8ClampedArray([64, 128, 192, 80, 0, 255, 0, 255]) }
  const original = [...data.data]
  assert.equal(displayImageData(data, 'STD'), data)
  assert.deepEqual([...data.data], original)
  displayImageData(data, 'VLOG')
  assert.ok(data.data[0] > 64)
  assert.ok(data.data[1] > 128)
  assert.equal(data.data[3], 80)
  assert.equal(data.data[7], 255)
  assert.equal(data.data[4], 0)
  assert.equal(data.data[5], 255)
})

test('VLog diagnostic histograms remain encoded while the displayed pixels use sRGB', () => {
  const image = { width: 3, height: 1, data: new Uint8ClampedArray([80, 100, 110, 255, 130, 145, 140, 255, 200, 180, 160, 255]) }
  const params = { ...defaultParams(), base_photo_style: 'VLOG' }
  const encoded = renderDiagnosticPixels(image, params)
  const diagnostics = measureDiagnostics(image, params)
  for (let pixel = 0; pixel < 3; pixel++) for (let channel = 0; channel < 3; channel++)
    assert.equal(diagnostics.current_pixels[pixel * 4 + channel], Math.round(displayComponent(encoded[pixel * 3 + channel], 'VLOG') * 255))
  assert.deepEqual(diagnostics.current.histograms, diagnostics.baseline.histograms)
  assert.equal(diagnostics.input_contract.output_encoding, 'Rec709')
})
