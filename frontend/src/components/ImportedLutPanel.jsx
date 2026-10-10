import { useEffect, useRef, useState } from 'react'
import { importLut, listImportedLuts, preloadExternalLut } from '../lib/importedLuts.js'
import { MAX_CUBE_BYTES } from '../lib/cubeLut.js'
import './ImportedLutPanel.css'

const SIGNALS = ['sRGB', 'Rec709', 'VLOG']
const EXTERNAL_FIELDS = ['external_lut_id', 'external_lut_strength', 'external_lut_mode']
export function compatibleImportedLut(artifact, params) {
  const output = params.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB'
  return artifact.mode === 'input'
    ? params.base_photo_style === 'VLOG' && artifact.input_encoding === 'VLOG' && artifact.output_encoding === 'Rec709'
    : artifact.input_encoding === output && artifact.output_encoding === output
}

export default function ImportedLutPanel({ params, disabled = false, locked = false, onCommit, onReady, onError, onLoading }) {
  const [artifacts, setArtifacts] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [file, setFile] = useState(null)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [strength, setStrength] = useState(params.external_lut_strength)
  const requestId = useRef(0)
  const paramsRef = useRef(params)
  paramsRef.current = params
  const blocked = disabled || (Array.isArray(locked) ? EXTERNAL_FIELDS.some(field => locked.includes(field)) : Boolean(locked))
  const blockedRef = useRef(blocked); blockedRef.current = blocked
  useEffect(() => {
    onLoading?.(loading)
    return () => onLoading?.(false)
  }, [loading, onLoading])
  useEffect(() => { setStrength(params.external_lut_strength) }, [params.external_lut_strength])
  useEffect(() => {
    let current = true
    listImportedLuts().then(rows => { if (current) setArtifacts(rows) }).catch(reason => { if (current) setError(reason.message) })
    return () => { current = false; requestId.current++ }
  }, [])
  function fail(reason) { setError(reason.message || String(reason)); onError?.(reason) }
  async function select(id) {
    if (blocked) return
    if (!id) { onCommit?.({ external_lut_id: null, external_lut_mode: 'display', external_lut_strength: 0 }); return }
    const request = ++requestId.current
    const source = { base: params.base_photo_style, external: params.external_lut_id }
    setLoading(true); setError('')
    try {
      const artifact = await preloadExternalLut(id)
      if (request !== requestId.current) return
      if (blockedRef.current || paramsRef.current.base_photo_style !== source.base || paramsRef.current.external_lut_id !== source.external) throw new Error('工作区或输入条件已改变，请重新选择外部 LUT')
      if (!compatibleImportedLut(artifact, paramsRef.current)) throw new Error('此 LUT 的信号声明与当前输入不兼容')
      onReady?.(artifact)
      onCommit?.({ external_lut_id: artifact.id, external_lut_mode: artifact.mode, external_lut_strength: 1 })
    } catch (reason) { if (request === requestId.current) fail(reason) }
    finally { if (request === requestId.current) setLoading(false) }
  }
  async function upload(event) {
    event.preventDefault()
    if (blocked || loading) return
    setError('')
    if (!file || !/\.cube$/i.test(file.name) || file.size > MAX_CUBE_BYTES) { fail(new Error('请选择不超过32MB的 .cube 文件')); return }
    if (!confirmed || !input || !output) { fail(new Error('请明确确认输入和输出信号')); return }
    const request = ++requestId.current
    setLoading(true)
    try {
      const artifact = await importLut(file, { input_encoding: input, output_encoding: output, confirmed: true })
      if (request !== requestId.current) return
      setArtifacts(rows => [artifact, ...rows.filter(row => row.id !== artifact.id)])
      setShowImport(false); setFile(null); setConfirmed(false)
      setError(compatibleImportedLut(artifact, paramsRef.current) ? '导入成功，可在列表中选择试套。' : '导入成功；当前输入不兼容，请切换到相应输入工作区后试套。')
    } catch (reason) { if (request === requestId.current) fail(reason) }
    finally { if (request === requestId.current) setLoading(false) }
  }
  function commitStrength() {
    if (blocked || loading || params.external_lut_mode === 'input' || strength === params.external_lut_strength) return
    onCommit?.({ external_lut_strength: strength })
  }
  const selected = artifacts.find(artifact => artifact.id === params.external_lut_id)
  return <section className="imported-lut-panel" aria-label="外部 LUT">
    <div className="imported-lut-heading"><h3>外部 LUT</h3><button type="button" disabled={blocked || loading} onClick={() => setShowImport(value => !value)}>导入 .cube</button></div>
    <label className="imported-lut-choice">账号导入库
      <select aria-label="外部 LUT 选择" disabled={blocked || loading} value={params.external_lut_id || ''} onChange={event => select(event.target.value)}>
        <option value="">不使用外部 LUT</option>
        {params.external_lut_id && !selected && <option value={params.external_lut_id}>当前引用（载入中）</option>}
        {artifacts.map(artifact => <option key={artifact.id} value={artifact.id} disabled={!compatibleImportedLut(artifact, params)}>
          {artifact.name} · {artifact.input_encoding} → {artifact.output_encoding}{compatibleImportedLut(artifact, params) ? '' : '（输入不兼容）'}
        </option>)}
      </select>
    </label>
    {params.external_lut_id && <>
      <div className="imported-lut-strength"><label htmlFor="external-lut-strength">{params.external_lut_mode === 'input' ? '输入转换强度' : '显示风格强度'}</label><output>{Math.round(strength * 100)}%</output>
        <input id="external-lut-strength" type="range" min={0} max={1} step={0.01} value={strength}
          disabled={blocked || loading || params.external_lut_mode === 'input'} onChange={event => setStrength(Number(event.target.value))}
          onPointerUp={commitStrength} onPointerCancel={() => setStrength(params.external_lut_strength)} onBlur={commitStrength} onKeyUp={commitStrength} />
      </div>
      <p className="imported-lut-help">{params.external_lut_mode === 'input'
        ? '此 LUT 替换 V-Log 技术转换，强度固定100%；内置 V-Log 显示映射不参与。系统相对调色与自由曲线随后应用。'
        : '在系统调色输出后叠加同编码的显示风格；独立于系统风格强度。'}</p>
    </>}
    {showImport && <form className="imported-lut-form" onSubmit={upload}>
      <label>三维 .cube 文件<input aria-label="选择 cube 文件" type="file" accept=".cube" disabled={loading} onChange={event => { setFile(event.target.files?.[0] || null); setConfirmed(false) }} /></label>
      <div className="imported-lut-signals">
        <label>输入信号<select required disabled={loading} value={input} onChange={event => { setInput(event.target.value); setConfirmed(false) }}><option value="">请选择</option>{SIGNALS.map(signal => <option key={signal}>{signal}</option>)}</select></label>
        <label>输出信号<select required disabled={loading} value={output} onChange={event => { setOutput(event.target.value); setConfirmed(false) }}><option value="">请选择</option>{SIGNALS.filter(signal => signal !== 'VLOG').map(signal => <option key={signal}>{signal}</option>)}</select></label>
      </div>
      <label className="imported-lut-confirm"><input type="checkbox" checked={confirmed} disabled={loading} onChange={event => setConfirmed(event.target.checked)} />我已依据 LUT 来源确认信号声明，且文件为 SDR。</label>
      <p className="imported-lut-help">支持纯3D 2–65点、R最快、DOMAIN。仅接受 sRGB→sRGB、Rec709→Rec709 或 VLOG→Rec709；不支持1D、混合及HDR。账号保存解析网格，不保存照片；导出33点可能降低高密度 LUT 细节。</p>
      <button type="submit" disabled={blocked || loading || !file || !confirmed}>{loading ? '正在导入…' : '确认并导入'}</button>
    </form>}
    {loading && <p className="imported-lut-status" role="status">正在载入外部 LUT…</p>}
    {error && <p className="imported-lut-status" role="status">{error}</p>}
  </section>
}
