import { useEffect, useId, useState } from 'react'
import SelectField from './SelectField.jsx'
import { inputContract } from '../lib/styleRecipe.js'
import { photoMetadataNotes } from '../lib/photoMetadata.js'
import { sampleIsNormalized } from '../lib/samples.js'
import './SampleGallery.css'

const VALIDATION_LABELS = { no_new_risk: '无新增风险', attention: '风险待关注', unmeasurable: '无法测量' }
function inputStatus(sample) {
  if (!sampleIsNormalized(sample)) return '输入需更新'
  return sample.input_confirmed ? '已确认 · ' + sample.input_contract?.base_photo_style : '输入待确认'
}

function SampleThumbnail({ sample, media, selected, primary, result, stale, onSelect }) {
  return <button className={'sg-thumbnail ' + (selected ? 'is-selected' : '')} onClick={onSelect}
    aria-pressed={selected} aria-label={'查看 ' + sample.name + (primary ? '，AI 主样张' : '') + '，' + inputStatus(sample)}>
    <span className="sg-thumb-image">{media?.thumbnail ? <img src={media.thumbnail} alt="" /> : <span>缺少预览</span>}</span>
    <span className="sg-thumb-copy"><strong title={sample.name}>{sample.name}</strong>
      <span className="sg-thumb-roles">{selected && <span className="sg-view-tag">查看中</span>}
        {primary && <span className="sg-primary-tag">★ AI 主样张</span>}{!selected && !primary && <span>验证图</span>}</span>
      <span className={'sg-input-tag ' + (!sample.input_confirmed || !sampleIsNormalized(sample) ? 'needs-attention' : '')}>{inputStatus(sample)}</span>
      {result && <span className={'sg-risk-tag ' + (!stale && result.status === 'attention' ? 'needs-attention' : !stale && result.status === 'no_new_risk' ? 'is-verified' : '')}>
        {stale ? '验证已过期' : VALIDATION_LABELS[result.status] || result.label || result.status}</span>}
    </span>
  </button>
}

function SampleDetails({ sample, media, primary, result, stale, busy, onPrimary, onRemove, onConfirm, onRebind, onGuide }) {
  const [style, setStyle] = useState(sample.input_contract?.base_photo_style || 'STD')
  const metadata = photoMetadataNotes(sample.photo_metadata)
  const needsDecode = !sampleIsNormalized(sample) || style !== sample.input_contract?.base_photo_style
  const needsConfirmation = !sample.input_confirmed || needsDecode
  const sourceWidth = sample.source_width || sample.photo_metadata?.source_width
  const sourceHeight = sample.source_height || sample.photo_metadata?.source_height
  return <div className="sg-selected-details">
    <div className="sg-detail-heading"><strong title={sample.name}>{sample.name}</strong><span>{primary ? '★ AI 主样张' : '当前查看 · 验证图'}</span></div>
    <dl className="sg-metadata"><dt>相机</dt><dd>{metadata.camera}</dd><dt>色彩</dt><dd>{metadata.color}</dd>
      {sourceWidth && sourceHeight && <><dt>原始尺寸</dt><dd>{sourceWidth} × {sourceHeight}</dd></>}
      {sample.width && sample.height && <><dt>预览尺寸</dt><dd>{sample.width} × {sample.height}</dd></>}
      <dt>原文件</dt><dd>{media?.file ? '已绑定，可用于照片分析及原尺寸导出' : media?.canvas ? '仅有缩小预览，原文件需重新绑定' : '图像未恢复，需重新绑定原文件'}</dd>
    </dl>
    {metadata.warning && <p className="sg-warning">{metadata.warning}</p>}
    <div className="sg-input-row"><label>照片输入<SelectField aria-label={sample.name + ' 输入基准'} value={style} onChange={(event) => setStyle(event.target.value)} disabled={busy}>
      <option value="STD">Standard</option><option value="NAT">Natural</option><option value="VIVD">Vivid</option><option value="VLOG">V-Log / V-Gamut</option>
    </SelectField></label>
      {needsConfirmation ? <button className="btn sg-action" disabled={busy || (needsDecode && !media?.file)}
        onClick={() => onConfirm({ ...inputContract({ base_photo_style: style, tone_map: 1 }), tone_map: sample.input_contract?.tone_map ?? 1 })}>确认照片输入基准</button>
        : <span className="sg-confirmed">已确认 · {style}</span>}
    </div>
    {needsConfirmation && <p className="sg-help">{needsDecode && !media?.file ? '请先重新绑定同一原文件，再更新或确认输入。' : metadata.input}</p>}
    {!media?.file && media?.canvas && <p className="sg-help">兼容的缓存预览可继续手调、比较版本与保存或导出 LUT；照片分析、参考匹配和原尺寸照片导出需要原文件。</p>}
    <div className="sg-detail-actions"><button className="btn sg-action" onClick={onPrimary} disabled={busy || primary}>设为 AI 主样张</button>
      <button className="btn sg-action" onClick={onRebind} disabled={busy}>{media?.file ? '重新绑定' : '绑定原文件'}</button>
      <button className="btn sg-action" onClick={onGuide}>输入与相机引导</button>
      <button className="btn-danger sg-action" onClick={onRemove} disabled={busy} aria-label={'移除 ' + sample.name}>移除照片</button></div>
    {result && <p className={'sg-validation ' + (stale ? 'is-stale' : result.status === 'attention' ? 'needs-attention' : result.status === 'no_new_risk' ? 'is-verified' : '')}>
      {stale && '此前验证 · '}{result.summary || result.label || VALIDATION_LABELS[result.status] || result.status}{result.reason && ' · ' + result.reason}</p>}
  </div>
}

export default function SampleGallery({ samples, media, selectedId, primaryId, validation, stale, busy,
  onSelect, onPrimary, onRemove, onConfirm, onAdd, onRebind, onValidate, retainPreviews, onRetain, onGuide, detailsRequest = 0 }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const selected = samples.find((sample) => sample.id === selectedId) || samples[0]
  const primary = samples.find((sample) => sample.id === primaryId)
  const resultFor = (id) => validation?.results?.find((result) => result.id === id || result.sample_id === id)
  useEffect(() => { if (detailsRequest > 0) setDetailsOpen(true) }, [detailsRequest])
  return <section className="sample-gallery sample-gallery-compact" aria-label="照片样张">
    <div className="sg-heading"><div className="sg-title"><h3>样张 <span>{samples.length}/5</span></h3>
      {primary && <span className="sg-main-summary" title={primary.name}>AI 主样张：{primary.name}</span>}</div>
      <div className="sg-heading-actions"><button className="btn sg-action" onClick={onAdd} disabled={busy || samples.length >= 5}>＋ 添加</button>
        <button className="btn sg-action" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen} aria-controls={detailsId}>
          {detailsOpen ? '收起详情' : selected ? '照片详情' : '设置与验证'} {detailsOpen ? '↑' : '↓'}</button></div>
    </div>
    {samples.length ? <div className="sg-strip">{samples.map((sample) => <SampleThumbnail key={sample.id} sample={sample} media={media.get(sample.id)}
      selected={sample.id === selected?.id} primary={sample.id === primaryId} result={resultFor(sample.id)} stale={stale} onSelect={() => onSelect(sample.id)} />)}</div>
      : <p className="sg-empty">添加相机直出照片，并确认输入。多张样张可用来检查同一效果，统计验证不发送给模型。</p>}
    {selected && <p className="sg-view-summary"><span>正在查看：<strong title={selected.name}>{selected.name}</strong></span>
      <span>{selected.id === primaryId ? '同时为 AI 主样张' : '切换查看不更换 AI 主样张'}</span></p>}
    <div className="sg-details" id={detailsId} hidden={!detailsOpen}>
      {selected && <SampleDetails key={selected.id + ':' + selected.input_contract?.base_photo_style} sample={selected} media={media.get(selected.id)}
        primary={selected.id === primaryId} result={resultFor(selected.id)} stale={stale} busy={busy}
        onPrimary={() => onPrimary(selected.id)} onRemove={() => onRemove(selected.id)} onConfirm={(contract) => onConfirm(selected.id, contract)}
        onRebind={() => onRebind(selected.id)} onGuide={() => onGuide(selected)} />}
      <div className="sg-gallery-settings"><div className="sg-validation-actions"><button className="btn sg-action" onClick={onValidate} disabled={busy || !samples.length}>验证全部样张的当前效果</button>
        {!selected && <button className="btn sg-action" onClick={() => onGuide()} disabled={busy}>输入与相机引导</button>}<span>统计测量，不调用模型</span></div>
        {validation && <details className="sg-validation-details"><summary>{stale ? '参数或样张已变化，上次验证仅供回看' : '查看全部统计验证详情'}</summary>
          <pre>{JSON.stringify(validation.results, null, 2)}</pre></details>}
        <label className="sg-preview-cache"><input type="checkbox" checked={retainPreviews} onChange={(event) => onRetain(event.target.checked)} disabled={busy} />
          <span>在本机保留缩小预览<small>最多 24MB，7 天后过期；不保留原文件</small></span></label>
      </div>
    </div>
  </section>
}
