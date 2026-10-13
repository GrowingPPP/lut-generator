import { useEffect, useState } from 'react'
import SelectField from './SelectField.jsx'
import ActionIcon from './ui/ActionIcon.jsx'
import { inputContract } from '../lib/styleRecipe.js'
import { sampleIsNormalized } from '../lib/samples.js'

export default function CreationPhotoSetup({ sample, media, primarySample, params, busy, sampleCount,
  onUpload, onRebind, onConfirm, onDetails, onGuide, onAdjust }) {
  const [style, setStyle] = useState(sample?.input_contract?.base_photo_style || params.base_photo_style)
  useEffect(() => setStyle(sample?.input_contract?.base_photo_style || params.base_photo_style),
    [sample?.id, sample?.input_contract?.base_photo_style, params.base_photo_style])
  const needsDecode = sample && (!sampleIsNormalized(sample) || style !== sample.input_contract?.base_photo_style)
  const confirmed = sample?.input_confirmed && !needsDecode
  return <section className="creation-photo-setup creation-side-section">
    <h2>{sample ? '确认照片的输入' : '从自己的照片开始'}</h2>
    <p className="tool-note">{sample ? '照片风格应与拍摄时的相机设置一致，EXIF 无法代替这一步确认。' : '上传相机直出照片。第一张会作为 AI 主样张，之后可添加其他照片检查同一效果。'}</p>
    {!sample && <button type="button" className="btn-primary" disabled={busy} onClick={onUpload}><ActionIcon name="upload" />选择照片</button>}
    {sample && <>
      <div className="creation-photo-identity"><strong>{sample.name}</strong><span>{sample.id === primarySample?.id ? '当前查看 · AI 主样张' : `当前查看 · AI 主样张为 ${primarySample?.name || '尚未选择'}`}</span></div>
      <label className="creation-field">拍摄时的照片风格<SelectField aria-label="拍摄时的照片风格" value={style}
        disabled={busy} onChange={event => setStyle(event.target.value)}>
        <option value="STD">Standard（标准）</option><option value="NAT">Natural（自然）</option>
        <option value="VIVD">Vivid（鲜艳）</option><option value="VLOG">V-Log / V-Gamut</option>
      </SelectField></label>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onGuide}><ActionIcon name="help" />不知道如何选择？</button>
      {!confirmed && <button type="button" className="btn-primary" disabled={busy || (needsDecode && !media?.file)}
        onClick={() => onConfirm(inputContract({ base_photo_style: style, tone_map: sample.input_contract?.tone_map ?? 1 }))}>确认照片输入</button>}
      {confirmed && <p className="creation-confirmed"><ActionIcon name="check" />照片输入已确认 · {style}</p>}
      {!media?.file && <div className="creation-rebind"><p>{media?.canvas ? '已恢复缩小预览。AI 照片分析和原尺寸导出需要原文件；兼容预览仍可手调和保存 LUT。' : '当前照片未恢复，请重新绑定电脑上的同一原文件。'}</p><button type="button" className={media?.canvas ? 'btn btn-soft' : 'btn-primary'} disabled={busy} onClick={onRebind}>重新绑定原文件</button></div>}
      <div className="creation-side-links"><button type="button" className="btn btn-ghost" onClick={onDetails}>照片详情与内容设置</button>
        <button type="button" className="btn btn-ghost" disabled={busy || sampleCount >= 5} onClick={onUpload}>＋ 添加检查照片</button></div>
    </>}
    <div className="creation-context-note"><p>多张照片共用一套效果。切换查看照片，不会更换 AI 主样张。</p>
      {!sample && <button type="button" className="btn btn-ghost" disabled={busy} onClick={onAdjust}>先手动创作 LUT</button>}
      {sample && confirmed && params.base_photo_style !== style && <p>这张照片与 LUT 的输入基准不同。请在“调效果”的输入技术设置中核对，再查看正式比较。</p>}
    </div>
  </section>
}
