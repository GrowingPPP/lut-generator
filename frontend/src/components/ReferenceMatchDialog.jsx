import { useEffect, useRef, useState } from 'react'
import { defaultParams } from '../lib/lutEngine.js'
import { decodeSample } from '../lib/samples.js'
import { matchingReferenceResult, requestReferenceMatch } from '../lib/referenceMatch.js'
import { diffParams } from '../lib/autoGrade.js'
import { RenderedImage } from './ComparisonPreview.jsx'
import useModalFocus from '../hooks/useModalFocus.js'
import './ReferenceMatchDialog.css'

export default function ReferenceMatchDialog({ file, image, params, context, workspaceId,
  sourceDigest, mainSampleId, compatible, onClose, onBusyChange, onPrepare, onApply }) {
  const [reference, setReference] = useState(null)
  const [color, setColor] = useState(true)
  const [tone, setTone] = useState(true)
  const [strength, setStrength] = useState(0.7)
  const [loading, setLoading] = useState(false)
  const [matching, setMatching] = useState(false)
  const [error, setError] = useState('')
  const [candidate, setCandidate] = useState(null)
  const generation = useRef(0)
  const running = loading || matching
  const modal = useModalFocus(onClose, !running)
  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => { setCandidate(null) }, [params, context, workspaceId, sourceDigest, mainSampleId])

  const upload = async (event) => {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (!selected) return
    const id = ++generation.current
    setLoading(true); setError(''); setCandidate(null)
    onBusyChange(true)
    try {
      const decoded = await decodeSample(selected, defaultParams())
      if (id === generation.current) setReference(decoded)
    } catch (failure) { if (id === generation.current) setError(failure.message) }
    finally { if (id === generation.current) { setLoading(false); onBusyChange(false) } }
  }
  const match = async () => {
    if (!reference || !compatible || !file || running || (!color && !tone)) return
    const id = ++generation.current
    const args = { file, reference: reference.file, params: structuredClone(params), context: structuredClone(context),
      workspaceId, sourceDigest, mainSampleId, referenceDigest: reference.metadata.source_digest,
      color, tone, strength }
    setMatching(true); setError(''); setCandidate(null); onBusyChange(true)
    try {
      const request = await onPrepare()
      if (request === false) return
      const result = await requestReferenceMatch(args)
      if (id !== generation.current) return
      if (!matchingReferenceResult(result, args)) throw new Error('参考匹配结果与冻结来源不一致，本次未应用')
      setCandidate({ result, request })
    } catch (failure) { if (id === generation.current) setError(failure.message) }
    finally { if (id === generation.current) { setMatching(false); onBusyChange(false) } }
  }
  const apply = async () => {
    if (!candidate || running) return
    setMatching(true); onBusyChange(true)
    try {
      if (await onApply(candidate.result, candidate.request) !== false) onClose()
      else setError('工作区或来源已变化，候选未应用，请重新匹配')
    } catch (failure) { setError(failure.message) }
    finally { setMatching(false); onBusyChange(false) }
  }
  const changes = candidate ? diffParams(candidate.result.before_params, candidate.result.params) : []
  return <div className="modal-backdrop">
    <section ref={modal} className="workspace-modal reference-match" role="dialog" aria-modal="true" aria-labelledby="reference-match-title">
      <div className="section-heading"><div><span className="reference-kicker">色彩与影调</span><h2 id="reference-match-title">参考图风格匹配</h2></div>
        <button className="btn" disabled={running} onClick={onClose}>关闭</button></div>
      <p className="workspace-note">参考图不会成为主样张。匹配在现有调色参数中寻找接近的色彩与影调，保留参数保护；场景和光照差异会影响结果。</p>
      <div className="reference-images">
        <RenderedImage image={image} params={params} label="当前效果" />
        {reference ? <RenderedImage image={reference.canvas} params={defaultParams()} label="参考图 · sRGB" />
          : <label className="reference-upload">选择参考照片<input type="file" accept="image/jpeg,image/png,image/webp" disabled={running} onChange={upload} /></label>}
        {candidate && <RenderedImage image={image} params={candidate.result.params} label="匹配候选 · 未应用" />}
      </div>
      {reference && <div className="reference-file"><span>{reference.metadata.name}</span>
        <label className="btn">更换参考图<input type="file" accept="image/jpeg,image/png,image/webp" disabled={running} onChange={upload} /></label></div>}
      {reference && reference.metadata.color_management?.warning && <p className="workspace-note">{reference.metadata.color_management.warning}</p>}
      <fieldset className="reference-options" disabled={running}>
        <label><input type="checkbox" checked={color} onChange={(e) => { setColor(e.target.checked); setCandidate(null) }} />匹配色彩</label>
        <label><input type="checkbox" checked={tone} onChange={(e) => { setTone(e.target.checked); setCandidate(null) }} />匹配影调</label>
        <label className="reference-strength">匹配强度 <output>{Math.round(strength * 100)}%</output>
          <input aria-label="参考匹配强度" type="range" min="0" max="1" step="0.05" value={strength}
            onChange={(e) => { setStrength(Number(e.target.value)); setCandidate(null) }} /></label>
      </fieldset>
      {(!compatible || !file) && <p className="workspace-note">请先绑定当前主样张原文件，并确认匹配的输入。</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {candidate && <div className="reference-result" aria-live="polite">
        <strong>{changes.length ? `${changes.length} 项调整 · 统计距离降低 ${candidate.result.improvement_pct.toFixed(1)}%` : '本次保留当前效果'}</strong>
        <p>{changes.map((change) => change.text).join('；')}</p>
        {candidate.result.warnings.map((warning) => <p className="workspace-note" key={warning}>{warning}</p>)}
      </div>}
      <p className="text-muted">确定性匹配不调用模型；两张原照片只在本次请求中处理，不在服务器保存。</p>
      <div className="modal-actions"><button className="btn" onClick={match}
        disabled={running || !reference || !file || !compatible || (!color && !tone)}>
        {loading ? '正在统一参考图色彩…' : matching ? '正在匹配…' : '生成匹配候选'}</button>
        <button className="btn-primary" disabled={running || !changes.length} onClick={apply}>应用候选</button></div>
    </section>
  </div>
}
