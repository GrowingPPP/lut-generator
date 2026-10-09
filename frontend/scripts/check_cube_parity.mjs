// 前端 .cube 序列化与后端 lut_engine/cube.py 的一致性校验。
// 判定标准(两者都是必须的):
//   1. header 完全一致:TITLE / #LUMIXPHOTOSTYLE / LUT_3D_SIZE 三行逐字节相同
//   2. 行数完全一致(size^3 个数据行)
//   3. 数值差异不超过 6 位小数下的 1 个最低位(1e-6)
//
// 差异来源已定位:后端 f"{v:.6f}" 用 Python round-half-even,前端 toFixed 用
// half-away-from-zero,叠加 JS Math.pow 与 numpy 的浮点差(V-Log 反曲线、ACES
// tone mapping、3x3 矩阵乘的累加次序)。实测:
//   - 纯 sRGB 路径(identity / warm / software)逐字节完全相同
//   - V-Log 与 gamma/矩阵路径最多 1 个最低位,占比 < 2.5% 的采样
// 1 个最低位 = 1/1e6,远低于 LUT 的量化精度,不影响画面。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defaultParams, paramsToCube } from '../src/lib/lutEngine.js'

const here = dirname(fileURLToPath(import.meta.url))
const backendDir = join(here, '..', '..', 'backend')
const venvPython = join(here, '..', '..', '.venv', 'bin', 'python')
const ULP = 1e-6 // 6 位小数下的 1 个最低位

const CASES = [
  { name: 'identity', params: {}, title: 'demo', mode: 'camera', bytesExact: true },
  { name: 'warm_camera', params: { temp: 520, tint: 100 }, title: '日系清透', mode: 'camera', bytesExact: true },
  { name: 'software_no_header', params: { contrast: 0.2 }, title: 'demo', mode: 'software', bytesExact: true },
  { name: 'software_vlog_signal', params: { base_photo_style: 'VLOG', look_strength: 0 }, title: 'vlog', mode: 'software' },
  { name: 'vlog_camera', params: { base_photo_style: 'VLOG', tone_map: 0.3 }, title: 'vlog', mode: 'camera' },
  { name: 'vlog_tone07', params: { base_photo_style: 'VLOG', tone_map: 0.7, exposure: 0.4, saturation: 0.2 }, title: 'vlog2', mode: 'camera' },
  { name: 'full_ops', params: { lift: [0.05, 0, -0.03], gamma: [0.9, 1, 1.1], gain: [1.05, 1, 0.95], vibrance: 0.3 }, title: 'full', mode: 'camera' },
  { name: 'tone_regions', params: { highlights: -0.7, shadows: 0.7, whites: 0.15, blacks: 0.15, curve: 0.6 }, title: 'tone', mode: 'camera' },
  { name: 'split_tone', params: { split_shadow_hue: 220, split_shadow_sat: 0.7, split_highlight_hue: 40, split_highlight_sat: 0.6, split_balance: 0.45 }, title: 'split', mode: 'camera' },
  { name: 'tone_extreme_vlog', params: { base_photo_style: 'VLOG', tone_map: 0.4, highlights: -1, shadows: 1, curve: 1, split_shadow_sat: 0.8, split_highlight_sat: 0.8, split_balance: 0.2 }, title: 'vlog-tone', mode: 'camera' },
  { name: 'selective_mid_strength', params: { selective_hue_center: 28, selective_hue_width: 50, selective_hue_shift: 16, selective_saturation: -0.25, split_mid_hue: 210, split_mid_sat: 0.28, look_strength: 0.65 }, title: 'look', mode: 'camera' },
]

const py = `
import json, sys
sys.path.insert(0, '.')
from lut_engine import lut_params_from_dict, generate_lut, lut_to_cube
spec = json.loads(sys.argv[1])
p = lut_params_from_dict(spec["params"])
lut = generate_lut(p, size=33)
style = p.base_photo_style if spec["mode"] == "camera" else None
input_signal = "VLOG/V-Gamut" if p.base_photo_style == "VLOG" else f"{p.base_photo_style}/sRGB"
output_signal = "Rec709" if p.base_photo_style == "VLOG" else "sRGB"
title = spec["title"] if spec["mode"] == "camera" else f"{spec['title']} [{input_signal} -> {output_signal}]"
sys.stdout.write(lut_to_cube(lut, title=title, photo_style=style))
`

let failures = 0
let totalValues = 0

for (const c of CASES) {
  const spec = JSON.stringify({ params: c.params, title: c.title, mode: c.mode })
  const want = execFileSync(venvPython, ['-c', py, spec], {
    cwd: backendDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const params = { ...defaultParams(), ...c.params }
  const got = paramsToCube(params, { title: c.title, mode: c.mode })

  if (c.bytesExact && got === want) {
    const n = got.split('\n').filter((l) => l).filter((l) => !l.startsWith('TITLE ') && !l.startsWith('#') && !l.startsWith('LUT_3D_SIZE ')).length
    totalValues += n * 3
    console.log(`ok   ${c.name} (逐字节一致, ${n} 数据行)`)
    continue
  }

  const gl = got.split('\n').filter((l) => l !== '')
  const wl = want.split('\n').filter((l) => l !== '')
  const HEADER = c.mode === 'camera' ? 3 : 2

  if (gl.length !== wl.length) {
    console.error(`FAIL ${c.name}: 行数 前端 ${gl.length} / 后端 ${wl.length}`)
    failures++
    continue
  }
  let bad = 0
  for (let i = 0; i < HEADER; i++) {
    if (gl[i] !== wl[i]) {
      console.error(`FAIL ${c.name} 行 ${i + 1}: 头不一致 got=${JSON.stringify(gl[i])} want=${JSON.stringify(wl[i])}`)
      bad++
    }
  }
  if (bad) { failures++; continue }

  let maxUlp = 0
  let nDiff = 0
  for (let i = HEADER; i < gl.length; i++) {
    const g = gl[i].split(' ')
    const w = wl[i].split(' ')
    for (let ch = 0; ch < g.length; ch++) {
      totalValues++
      if (g[ch] === w[ch]) continue
      nDiff++
      const ulp = Math.round(Math.abs(Number(g[ch]) - Number(w[ch])) / ULP)
      if (ulp > maxUlp) maxUlp = ulp
      if (ulp > 1 && bad < 6) {
        console.error(`FAIL ${c.name} 行 ${i + 1} ch${ch}: got=${g[ch]} want=${w[ch]} (${ulp} ULP)`)
        bad++
      }
    }
  }
  if (bad || maxUlp > 1) {
    failures++
  } else {
    const pct = ((nDiff / (gl.length - HEADER) / 3) * 100).toFixed(2)
    console.log(`ok   ${c.name} (${gl.length - HEADER} 数据行, 异值 ${nDiff} 个 = ${pct}%, 最大 ${maxUlp} ULP)`)
  }
}

if (failures) {
  console.error(`FAIL: ${failures}/${CASES.length} 不一致`)
  process.exit(1)
}
console.log(`PASS: .cube 序列化 ${CASES.length} cases / ${totalValues} 个数值,差异均在 1 个最低位内`)
