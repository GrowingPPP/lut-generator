import { useEffect, useId, useRef, useState } from 'react'
import CheckboxField from './ui/CheckboxField.jsx'
import SelectField from './SelectField.jsx'
import ActionMenu from './ui/ActionMenu.jsx'
import ActionIcon from './ui/ActionIcon.jsx'
import { useDialogs } from './ui/Dialog.jsx'
import { inputContract } from '../lib/styleRecipe.js'
import { photoMetadataNotes } from '../lib/photoMetadata.js'
import { normalizeSubjectMode, sampleIsNormalized, SUBJECT_MODE_LABELS } from '../lib/samples.js'
import { subjectSelection, subjectStatusText, SUBJECT_SELECTION_LABELS } from '../lib/subjectAnalysis.js'
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
      <span>{subjectStatusText(sample)}</span>
      {result && <span className={'sg-risk-tag ' + (!stale && result.status === 'attention' ? 'needs-attention' : !stale && result.status === 'no_new_risk' ? 'is-verified' : '')}>
        {stale ? '验证已过期' : VALIDATION_LABELS[result.status] || result.label || result.status}</span>}
    </span>
  </button>
}

function SampleDetails({ sample, media, primary, result, stale, busy, onPrimary, onRemove, onConfirm, onRebind, onGuide, onSubjectChange }) {
  const [style, setStyle] = useState(sample.input_contract?.base_photo_style || 'STD')
  const dialogs = useDialogs()
  const mounted = useRef(false)
  const current = useRef({ busy, revision: 0 })
  if (current.current.busy !== busy) current.current.revision++
  current.current = { sample, busy, revision: current.current.revision, onRemove }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const metadata = photoMetadataNotes(sample.photo_metadata)
  const needsDecode = !sampleIsNormalized(sample) || style !== sample.input_contract?.base_photo_style
  const needsConfirmation = !sample.input_confirmed || needsDecode
  const needsOriginal = !media?.file
  const remove = async () => {
    const captured = current.current
    const confirmed = await dialogs.confirm({ title: `移除样张「${sample.name}」？`,
      description: '仅移除此调色项目中的样张引用。电脑上的原照片、当前调色参数和已保存的 LUT 都会保留。',
      destructive: true, confirmLabel: '移除样张' })
    const latest = current.current
    if (confirmed && mounted.current && !latest.busy && latest.revision === captured.revision &&
      latest.sample.id === captured.sample.id && latest.sample.source_digest === captured.sample.source_digest) latest.onRemove()
  }
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
      <button type="button" className="btn btn-ghost sg-action" disabled={busy} onClick={onGuide}><ActionIcon name="help" />如何选择？</button>
      {needsConfirmation ? <button className={needsOriginal ? 'btn sg-action' : 'btn-primary sg-action'} disabled={busy || (needsDecode && !media?.file)}
        onClick={() => onConfirm({ ...inputContract({ base_photo_style: style, tone_map: 1 }), tone_map: sample.input_contract?.tone_map ?? 1 })}><ActionIcon name="check" />确认照片输入</button>
        : <span className="sg-confirmed">已确认 · {style}</span>}
    </div>
    {onSubjectChange && <div className="sg-input-row"><label>当前照片内容
      <SelectField aria-label={sample.name + ' 照片内容'} value={subjectSelection(sample)}
        onChange={event => onSubjectChange(event.target.value)} disabled={busy}>
        {Object.entries(SUBJECT_SELECTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
    </label><span>仅用于这张照片</span></div>}
    {onSubjectChange && <p className="sg-help">{subjectStatusText(sample)}。主样张的保护区域可在“AI 创作”中查看与修正。</p>}
    {needsConfirmation && <p className="sg-help">{needsDecode && !media?.file ? '请先重新绑定同一原文件，再更新或确认输入。' : metadata.input}</p>}
    {!media?.file && media?.canvas && <p className="sg-help">兼容的缓存预览可继续手调、比较版本与保存或导出 LUT；照片分析、参考匹配和原尺寸照片导出需要原文件。</p>}
    {needsOriginal && <div className="sg-next-action"><p>绑定原文件后，可以进行照片分析和原尺寸导出；已有兼容预览可继续手动调色。</p>
      <button type="button" className="btn-primary sg-action" onClick={onRebind} disabled={busy}><ActionIcon name="upload" />绑定原文件</button></div>}
    <div className="sg-detail-actions">
      {primary ? <span className="sg-primary-state"><ActionIcon name="star" />已为 AI 主样张</span>
        : <button type="button" className="btn btn-soft sg-action" onClick={onPrimary} disabled={busy}><ActionIcon name="star" />设为 AI 主样张</button>}
      <ActionMenu label={`管理样张 ${sample.name}`} disabled={busy} trigger={<button type="button" className="btn btn-ghost sg-action" aria-label={`管理样张 ${sample.name}`}><ActionIcon name="more" />更多</button>} items={[
        media?.file && { id: 'rebind', label: '重新绑定原文件', description: '保留当前样张的输入与人物设置', onSelect: onRebind },
        { id: 'guide', label: '输入与相机引导', onSelect: onGuide },
        { id: 'remove', label: '移除样张…', description: '保留原照片和已保存 LUT', separator: true, destructive: true, onSelect: remove },
      ]} />
    </div>
    {result && <p className={'sg-validation ' + (stale ? 'is-stale' : result.status === 'attention' ? 'needs-attention' : result.status === 'no_new_risk' ? 'is-verified' : '')}>
      {stale && '此前验证 · '}{result.summary || result.label || VALIDATION_LABELS[result.status] || result.status}{result.reason && ' · ' + result.reason}</p>}
    {result && <dl className="sg-metadata"><dt>当次照片内容</dt>
      <dd>{Object.hasOwn(result, 'subject_mode') ? SUBJECT_MODE_LABELS[normalizeSubjectMode(result.subject_mode)] : '未记录'}</dd>
      <dt>肤色区域保护</dt><dd>{typeof result.skin_protection_applied === 'boolean'
        ? result.skin_protection_applied ? '已参与验证' : '未参与验证' : '未记录'}</dd>
    </dl>}
  </div>
}

export default function SampleGallery({ samples, media, selectedId, primaryId, validation, stale, busy,
  onSelect, onPrimary, onRemove, onConfirm, onAdd, onRebind, onValidate, retainPreviews, onRetain, onGuide, onSubjectChange, detailsRequest = 0 }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  const selected = samples.find((sample) => sample.id === selectedId) || samples[0]
  const primary = samples.find((sample) => sample.id === primaryId)
  const resultFor = (id) => validation?.results?.find((result) => result.id === id || result.sample_id === id)
  useEffect(() => { if (detailsRequest > 0) setDetailsOpen(true) }, [detailsRequest])
  return <section className="sample-gallery sample-gallery-compact" aria-label="照片样张">
    <div className="sg-heading"><div className="sg-title"><h3>样张 <span>{samples.length}/5</span></h3>
      {primary && <span className="sg-main-summary" title={primary.name}>AI 主样张：{primary.name}</span>}</div>
      <div className="sg-heading-actions"><button className="btn btn-ghost sg-action" onClick={onAdd} disabled={busy || samples.length >= 5}>＋ 添加</button>
        <button className="btn btn-ghost sg-action" onClick={() => setDetailsOpen((open) => !open)} aria-expanded={detailsOpen} aria-controls={detailsId}>
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
        onRebind={() => onRebind(selected.id)} onGuide={() => onGuide(selected)}
        onSubjectChange={typeof onSubjectChange === 'function' ? mode => onSubjectChange(selected.id, mode) : undefined} />}
      <div className="sg-gallery-settings"><div className="sg-validation-actions"><button className="btn sg-action" onClick={onValidate} disabled={busy || !samples.length}>验证全部样张的当前效果</button>
        {!selected && <button className="btn btn-ghost sg-action" onClick={() => onGuide()} disabled={busy}>输入与相机引导</button>}<span>统计测量，不调用模型</span></div>
        {validation && <details className="sg-validation-details"><summary>{stale ? '参数或样张已变化，上次验证仅供回看' : '查看全部统计验证详情'}</summary>
          <p className="sg-help">人物识别或人工标注确定保护区域后，统计检查区域内的肤色变化。自动区域是近似矩形；尚无可用区域时不按全图暖色猜测肤色。</p>
          <pre>{JSON.stringify(validation.results, null, 2)}</pre></details>}
        <label className="sg-preview-cache"><CheckboxField checked={retainPreviews} onChange={(event) => onRetain(event.target.checked)} disabled={busy} />
          <span>在本机保留缩小预览<small>最多 24MB，7 天后过期；不保留原文件</small></span></label>
      </div>
    </div>
  </section>
}
