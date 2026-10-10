import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/themes.css', import.meta.url), 'utf8')
const palettes = {}
for (const [, name = 'dark', body] of css.matchAll(/:root(?:\[data-theme='([^']+)'\])?\s*\{([^}]+)\}/g)) {
  palettes[name] = Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)]
    .map(([, key, value]) => [key, value]))
}

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/)
  const values = hex.slice(1).match(/../g).map(pair => {
    const value = parseInt(pair, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

for (const name of ['dark', 'gray', 'light']) {
  test(`${name} theme preserves readable text, status and primary button contrast`, () => {
    assert.ok(palettes[name], `Missing ${name} palette`)
    const tokens = { ...palettes.dark, ...palettes[name] }
    const pairs = ['text', 'muted', 'faint', 'accent', 'accent-strong'].flatMap(text =>
      ['ink', 'panel', 'panel2', 'field', 'hover'].map(surface => [text, surface]))
    for (const status of ['danger', 'success', 'warn', 'info']) pairs.push([status, `${status}-soft`])
    pairs.push(['on-accent', 'accent'], ['photo-text', 'photo-surround'], ['photo-muted', 'photo-surround'])
    for (const [text, surface] of pairs) {
      const ratio = contrast(tokens[text], tokens[surface])
      assert.ok(ratio >= 4.5, `${name}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`)
    }
  })
}
