import test from 'node:test'
import assert from 'node:assert/strict'
import { identifyCamera, cameraGuideText, cameraInputAdvice } from '../src/lib/cameraGuide.js'
import { defaultParams } from '../src/lib/lutEngine.js'

test('unknown cameras use generic guidance and specific supported models are recognized', () => {
  assert.equal(identifyCamera('DC-S5M2X'), 's5iix')
  assert.equal(identifyCamera('DC-S5M2'), 's5ii')
  assert.equal(identifyCamera('DC-S9'), 'other')
})

test('guide encodes the current input and warns about V-Log double conversion', () => {
  const params = { ...defaultParams(), base_photo_style: 'VLOG' }
  const text = cameraGuideText({ params, filename: 'CHROMA.cube', model: 'S5II' })
  assert.match(text, /输出：Rec.709/)
  assert.match(text, /33 点 full-range/)
  assert.match(text, /不要再串联/)
  assert.match(cameraInputAdvice('NAT'), /My Photo Style.*NAT/)
  assert.match(text, /验收尚待执行/)
})
