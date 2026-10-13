import { useState } from 'react'
import SelectField from './SelectField.jsx'
import ActionIcon from './ui/ActionIcon.jsx'
import { inputContract } from '../lib/styleRecipe.js'
import { sampleIsNormalized } from '../lib/samples.js'
import { photoMetadataNotes } from '../lib/photoMetadata.js'

export default function SampleInputPreview({ sample, media, params, busy, onConfirm, onRebind, onDetails, onInput }) {
  const [style, setStyle] = useState(sample.input_contract?.base_photo_style || params.base_photo_style)
  const normalized = sampleIsNormalized(sample)
  const pending = !sample.input_confirmed
  const notes = photoMetadataNotes(sample.photo_metadata)
  return <section className="sample-input-preview" aria-label="上传照片与输入确认">
    <div className="sample-input-image">
      <img src={media.thumbnail} alt={`${sample.name} 原图预览`} />
      <span className="tag tag-orig">原图 · {pending ? '输入待确认' : '输入需核对'}</span>
    </div>
    <div className="sample-input-controls">
      <p>{!normalized
        ? '这是旧缓存预览，请重新绑定原文件并更新色彩处理后再对比。'
        : pending ? '照片已载入。请按拍摄时的 Photo Style 确认输入，确认后显示 LUT 对比。'
          : `照片输入为 ${sample.input_contract.base_photo_style}，当前 LUT 输入为 ${params.base_photo_style}，请核对输入后再对比。`}</p>
      {pending && normalized ? <div className="sample-input-actions">
        <label>照片输入<SelectField aria-label="预览照片输入基准" value={style} disabled={busy} onChange={event => setStyle(event.target.value)}>
          <option value="STD">Standard</option><option value="NAT">Natural</option><option value="VIVD">Vivid</option><option value="VLOG">V-Log / V-Gamut</option>
        </SelectField></label>
        <button className="btn-primary" disabled={busy} onClick={() => onConfirm({ ...inputContract({ base_photo_style: style, tone_map: 1 }), tone_map: sample.input_contract?.tone_map ?? 1 })}><ActionIcon name="check" />确认并查看对比</button>
      </div> : <div className="sample-input-actions">
        <button className="btn-primary" disabled={busy} onClick={normalized ? onDetails : onRebind}>{normalized ? '查看照片输入' : '重新绑定照片'}</button>
        <button className="btn btn-ghost" onClick={onInput}>检查 LUT 输入</button>
      </div>}
      {notes.color && <small>{notes.color}</small>}
    </div>
  </section>
}
