import assert from 'node:assert/strict'
import test from 'node:test'
import { identityCurves, validateCurvePoints, prepareCurve } from '../src/lib/curveMath.js'
import { parseCube, sampleImportedLut, validateExternalId } from '../src/lib/cubeLut.js'
import { registerExternalLut, resolveExternalLut, clearExternalLutCache, preloadExternalLut } from '../src/lib/importedLuts.js'
import { defaultParams, normalizeParams, generateLUT, paramsToCube } from '../src/lib/lutEngine.js'
import { recordStyleContribution, createProjection, validateParams, validateRecipe, applyStyleRecipe, inputContract } from '../src/lib/styleRecipe.js'
import { technicalBaseline } from '../src/lib/diagnostics.js'
import { compareVersionParams } from '../src/lib/versionComparison.js'
import { diffParams } from '../src/lib/autoGrade.js'

const ID = '11111111-2222-3333-4444-555555555555'
function cube(transform = (r,g,b) => [r,g,b], domain = false) {
  const lines = ['TITLE "颜色测试"', 'LUT_3D_SIZE 2']
  if (domain) lines.push('DOMAIN_MIN 0.1 0.2 0.3', 'DOMAIN_MAX 0.9 0.8 0.7')
  for (const b of [0,1]) for (const g of [0,1]) for (const r of [0,1]) lines.push(transform(r,g,b).join(' '))
  return lines.join('\n') + '\n'
}
const artifact = (signal = 'sRGB') => ({ ...parseCube(cube((r,g,b) => [b,r,g])), id: ID,
  input_encoding: signal, output_encoding: signal === 'VLOG' ? 'Rec709' : signal, mode: signal === 'VLOG' ? 'input' : 'display' })

test('legacy defaults migrate with fresh identity curves and structured values are checked', () => {
  const a = normalizeParams({exposure:.2}), b = defaultParams()
  assert.equal(Object.keys(a).length, 34)
  a.curve_points.master[0][1] = .1
  assert.equal(b.curve_points.master[0][1], 0)
  assert.equal(normalizeParams({external_lut_id:ID.toUpperCase()}).external_lut_id, ID)
  assert.throws(() => normalizeParams({external_lut_id:'bad'}))
  assert.throws(() => validateCurvePoints({...identityCurves(), b:[[0,0],[.5,.6],[.6,.5],[1,1]]}))
  assert.throws(() => validateCurvePoints({...identityCurves(), r:[[0,true],[1,1]]}))
})

test('PCHIP stays monotone including flat segments, passes points and never overshoots', () => {
  const points = [[0,.1],[.1,.4],[.5,.4],[.9,.8],[1,.9]], curve = prepareCurve(points)
  let previous = curve(0)
  for (let index=1;index<=10000;index++) { const value=curve(index/10000); assert.ok(value>=previous-1e-12);assert.ok(value>=.1&&value<=.9);previous=value }
  for (const [x,y] of points) assert.ok(Math.abs(curve(x)-y)<1e-12)
})

test('cube parser supports R-fastest order, BOM, CR lines and SDR DOMAIN', () => {
  const lut = parseCube('\uFEFF'+cube((r,g,b)=>[.2*r+.8*b,g,.7*r+.3*b],true).replaceAll('\n','\r'))
  assert.deepEqual([...lut.data.slice(3,6)].map(value=>Math.round(value*10)/10), [.2,0,.7])
  assert.ok(sampleImportedLut(lut,.5,.5,.5).every(value=>Math.abs(value-.5)<2e-8))
  assert.deepEqual(sampleImportedLut(lut,0,0,0),[0,0,0])
  assert.deepEqual(sampleImportedLut(lut,1,1,1),[1,1,1])
})

test('cube rejects unsupported dimensions, mixed/HDR formats, counts, headers and illegal values', () => {
  for (const text of [cube().replace('LUT_3D_SIZE 2','LUT_1D_SIZE 2'),cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 66'),
    cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nLUT_1D_SIZE 2'),cube()+'0 0 0\n',cube()+'DOMAIN_MAX 1 1 1',
    cube().replace('0 0 0','NaN 0 0'),cube().replace('0 0 0','1e999 0 0'),cube().replace('0 0 0','١ 0 0'),
    cube().replace('0 0 0','1.1 0 0'),cube().replace('TITLE "颜色测试"','TITLE "bad\x00title"'),
    cube().replace('LUT_3D_SIZE 2','DOMAIN_MIN -1 0 0\nLUT_3D_SIZE 2')]) assert.throws(()=>parseCube(text),text)
})

test('reference cache rejects missing/corrupt data and clearing a pending account fetch prevents revival', async () => {
  clearExternalLutCache()
  assert.throws(()=>resolveExternalLut(ID))
  assert.throws(()=>registerExternalLut(ID,{...artifact(),data:new Float32Array(2)}))
  const current=registerExternalLut(ID,artifact())
  assert.equal(resolveExternalLut(ID),current)
  const oldFetch=globalThis.fetch
  clearExternalLutCache()
  let release
  globalThis.fetch=async path => path.endsWith('/data')
    ? {ok:true,status:200,arrayBuffer:async()=>artifact().data.buffer}
    : {ok:true,status:200,json:async()=>new Promise(resolve=>{release=()=>resolve(artifact())})}
  try {
    const loading=preloadExternalLut(ID)
    await Promise.resolve();clearExternalLutCache();release()
    await assert.rejects(loading,/缓存已清除/)
    assert.throws(()=>resolveExternalLut(ID))
  } finally { globalThis.fetch=oldFetch;clearExternalLutCache() }
})

test('display effect is baked into cube, resolves before generation, and ignores system look strength', () => {
  clearExternalLutCache()
  const params={...defaultParams(),external_lut_id:ID,external_lut_strength:1,look_strength:0,contrast:.5}
  assert.throws(()=>generateLUT(params,3))
  registerExternalLut(ID,artifact())
  const {data}=generateLUT(params,3)
  assert.deepEqual([...data.slice(4,7)],[0,.5,0])
  assert.ok(paramsToCube(params,{size:3}).includes('0.000000 0.500000 0.000000'))
  assert.throws(()=>generateLUT({...params,base_photo_style:'VLOG'},3))
  clearExternalLutCache()
})

test('V-Log input converter skips built-in mapping and baseline preserves selected technical converter', () => {
  registerExternalLut(ID,{...artifact('VLOG'),...parseCube(cube())})
  const params={...defaultParams(),base_photo_style:'VLOG',external_lut_id:ID,external_lut_mode:'input',external_lut_strength:1,tone_map:0}
  const a=generateLUT(params,5).data, b=generateLUT({...params,tone_map:1},5).data
  assert.deepEqual(a,b)
  const identity=generateLUT(defaultParams(),5).data
  a.forEach((value,index)=>assert.ok(Math.abs(value-identity[index])<1e-7))
  const baseline=technicalBaseline({...params,exposure:.3,curve_points:{...identityCurves(),master:[[0,.1],[1,1]]}})
  assert.equal(baseline.external_lut_id,ID);assert.equal(baseline.external_lut_strength,1);assert.equal(baseline.external_lut_mode,'input')
  assert.equal(baseline.exposure,0);assert.deepEqual(baseline.curve_points,identityCurves())
  clearExternalLutCache()
})

test('partial field edits validate individually, combined candidate validates dependencies', () => {
  validateParams({external_lut_strength:.5},{complete:false})
  validateParams({external_lut_mode:'input'},{complete:false})
  assert.throws(()=>validateParams({...defaultParams(),external_lut_strength:.5}))
  assert.throws(()=>validateParams({external_lut_strength:true},{complete:false}))
  validateParams({...defaultParams(),external_lut_id:ID,external_lut_strength:.5})
})

test('curve and external contributions are SET, carry full dependencies, and preserve locks on application', () => {
  const before=defaultParams(),after={...before,curve_points:{...identityCurves(),master:[[0,.1],[1,1]]},external_lut_id:ID,external_lut_strength:.7}
  const projection=recordStyleContribution(createProjection(before),before,after,{id:'manual'})
  assert.equal(projection.operations.curve_points.mode,'set')
  assert.equal(projection.operations.external_lut_id.mode,'set')
  assert.equal(projection.operations.external_lut_strength.mode,'set')
  assert.deepEqual(projection.operations.external_lut_mode,{mode:'set',value:'display',dependency:true})
  const recipe={format_version:1,kind:'portable_style',input_contract:inputContract(before),operations:projection.operations,source:{}}
  assert.deepEqual(applyStyleRecipe(recipe,before),after)
  assert.throws(()=>applyStyleRecipe(recipe,before,{lockedFields:['curve_points']}))
  assert.throws(()=>validateRecipe({...recipe,operations:{...recipe.operations,curve_points:{mode:'add',value:after.curve_points}}}))
  const partial=structuredClone(recipe);delete partial.operations.external_lut_mode
  assert.throws(()=>validateRecipe(partial))
})

test('manual effects appear in version differences without object/UUID rendering leaks', () => {
  const before=defaultParams(),after={...before,curve_points:{...identityCurves(),master:[[0,.1],[1,1]]},external_lut_id:ID,external_lut_strength:.7}
  const changes=diffParams(before,after)
  assert.equal(changes.length,3);assert.ok(changes.find(row=>row.key==='curve_points').text.includes('控制点'))
  assert.ok(!changes.some(row=>row.text.includes('[object Object]')||row.text.includes(ID)))
  assert.equal(compareVersionParams(before,after).changedCount,3)
  assert.equal(compareVersionParams(before,structuredClone(before)).identical,true)
})
