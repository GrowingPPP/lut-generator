// 前后端引擎数学一致性校验:读 golden.json,用前端 lutEngine 重算并对比。
// 用法:cd frontend && node scripts/check_parity.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generateLUT, defaultParams } from '../src/lib/lutEngine.js'

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(readFileSync(join(here, '..', '..', 'golden.json'), 'utf8'))
const size = golden.size
let failures = 0
let total = 0

for (const c of golden.cases) {
  const params = { ...defaultParams(), ...c.params }
  const { data } = generateLUT(params, size)
  for (const s of c.samples) {
    const [r, g, b] = s.idx
    const base = (b * size * size + g * size + r) * 4
    for (let ch = 0; ch < 3; ch++) {
      const got = data[base + ch]
      const want = s.out[ch]
      total++
      if (Math.abs(got - want) > 1e-6) {
        failures++
        console.error(`MISMATCH case=${c.name} idx=${s.idx} ch=${ch} got=${got} want=${want}`)
      }
    }
  }
}

if (failures) {
  console.error(`FAIL: ${failures}/${total} mismatches`)
  process.exit(1)
}
console.log(`PASS: ${golden.cases.length} cases, ${total} samples`)
