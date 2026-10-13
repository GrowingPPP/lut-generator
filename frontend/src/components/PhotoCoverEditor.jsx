import { useEffect, useRef, useState } from 'react'
import { photoCover } from '../lib/assetCovers.js'
import { ErrorNotice } from './ui/Notice.jsx'

export default function PhotoCoverEditor({ assetId, currentUrl, disabled, onChange, onBusyChange }) {
  const input = useRef(null), generation = useRef(0)
  const [candidate, setCandidate] = useState(null)
  const [url, setUrl] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => () => { ++generation.current; onBusyChange?.(false) }, [assetId, onBusyChange])
  useEffect(() => {
    if (!(candidate instanceof Blob)) { setUrl(null); return }
    const value = URL.createObjectURL(candidate)
    setUrl(value)
    return () => URL.revokeObjectURL(value)
  }, [candidate])
  const select = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const request = ++generation.current
    setError(null); setLoading(true); onBusyChange?.(true)
    try {
      const blob = await photoCover(file)
      if (request !== generation.current) return
      setCandidate(blob); onChange(blob)
    } catch (failure) { if (request === generation.current) setError(failure) }
    finally { if (request === generation.current) { setLoading(false); onBusyChange?.(false) } }
  }
  const shown = candidate === false ? null : url || currentUrl
  return <section className="photo-cover-editor" aria-label="本机照片封面" aria-busy={loading}>
    <div className="photo-cover-heading"><strong>照片封面 · 本机</strong><span>{candidate !== null ? '待保存' : shown ? '已设置' : '未设置'}</span></div>
    <p>主动选择一张代表作品的照片。只保存最长边 640px 的缩小副本，不上传；仅当前浏览器可见，不影响 LUT 参数。</p>
    {shown && <img className="photo-cover-preview" src={shown} alt="待保存或当前的照片封面" />}
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" aria-label="选择本机照片封面" hidden onChange={select} disabled={disabled || loading} />
    <div className="photo-cover-actions">
      <button type="button" className="btn btn-soft" disabled={disabled || loading} onClick={() => input.current?.click()}>{loading ? '正在缩小照片…' : shown ? '替换照片封面' : '选择照片封面'}</button>
      {shown && <button type="button" className="btn btn-ghost" disabled={disabled || loading} onClick={() => { ++generation.current; setCandidate(false); onChange(false); setError(null) }}>移除照片封面</button>}
    </div>
    <ErrorNotice error={error} fallback="照片封面未能生成，请选择其他图片后重试。" />
  </section>
}
