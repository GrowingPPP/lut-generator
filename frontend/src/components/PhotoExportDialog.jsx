import RangeField from './ui/RangeField.jsx'
import { useState } from 'react'
import SelectField from './SelectField.jsx'
import { ModalSurface } from './ui/Dialog.jsx'
import { exportPhoto, savePhotoFile } from '../lib/photoApi.js'
import { sampleIsNormalized } from '../lib/samples.js'
import './PhotoExportDialog.css'

export default function PhotoExportDialog({ sample, media, params, compatible, onClose, onBusyChange }) {
  const [format, setFormat] = useState('jpeg')
  const [quality, setQuality] = useState(95)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const available = !!media?.file && compatible && sampleIsNormalized(sample)
  const width = sample?.source_width || sample?.photo_metadata?.source_width
  const height = sample?.source_height || sample?.photo_metadata?.source_height
  const submit = async () => {
    if (!available || saving) return
    const request = { file: media.file, sourceDigest: sample.source_digest,
      params: structuredClone(params), format, quality }
    setSaving(true)
    onBusyChange?.(true)
    setError('')
    try {
      const result = await exportPhoto(request)
      savePhotoFile(result.blob, result.name)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
      onBusyChange?.(false)
    }
  }
  return (
    <ModalSurface onClose={onClose} busy={saving}>
      <section className="workspace-modal photo-export-modal" role="dialog"
        aria-modal="true" aria-labelledby="photo-export-title">
        <div className="section-heading">
          <h2 id="photo-export-title">导出调整后照片</h2>
          <button className="btn" disabled={saving} onClick={onClose}>关闭</button>
        </div>
        <div className="photo-export-source">
          <strong>{sample?.name || '尚未选择照片'}</strong>
          {width && height && <span>原分辨率 {width} × {height}</span>}
          <span>使用当前全部效果，输出 sRGB</span>
        </div>
        <p className="workspace-note">
          导出从原文件计算，保留已校正方向的原始分辨率。V-Log 的显示结果转换为 sRGB；
          文件包含 sRGB 色彩配置，移除原照片的定位和其他拍摄元数据。
        </p>
        <div className="photo-export-options">
          <label>文件格式
            <SelectField aria-label="照片导出格式" value={format} disabled={saving}
              onChange={(e) => setFormat(e.target.value)}>
              <option value="jpeg">JPEG · 体积较小</option>
              <option value="png">PNG · 无损保存结果</option>
            </SelectField>
          </label>
          {format === 'jpeg' && <label>JPEG 质量 <output>{quality}</output>
            <RangeField aria-label="JPEG 导出质量" min="80" max="100" step="1"
              value={quality} disabled={saving} onChange={(e) => setQuality(Number(e.target.value))}/>
          </label>}
        </div>
        <p className="text-muted">
          {format === 'png' ? 'PNG 无损保存本次 8 位 RGB 调整结果，文件通常较大。' : 'JPEG 使用有损压缩；较高质量可以保留更多细节。'}
        </p>
        {!available && <p className="error" role="alert">
          {!media?.file ? '原分辨率导出需要重新绑定原文件。' : '请先确认照片输入并完成色彩规范化，再导出。'}
        </p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="btn" disabled={saving} onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={!available || saving} onClick={submit}>
            {saving ? '正在计算原分辨率效果…' : '导出照片'}
          </button>
        </div>
      </section>
    </ModalSurface>
  )
}
