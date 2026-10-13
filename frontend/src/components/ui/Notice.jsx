import { useEffect, useRef, useState } from 'react'
import ActionIcon from './ActionIcon.jsx'
import { createNotice } from '../../lib/notices.js'
import './Notice.css'

export default function Notice({ notice, onDismiss, action, children, className = '' }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const remaining = useRef(notice?.duration || 0)
  useEffect(() => { remaining.current = notice?.duration || 0 }, [notice?.id, notice?.duration])
  useEffect(() => {
    if (!notice?.duration || !onDismiss || paused) return undefined
    const started = Date.now()
    const timer = setTimeout(() => onDismiss(notice.id), remaining.current)
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)) }
  }, [notice?.id, notice?.duration, onDismiss, paused])
  if (!notice?.message) return null
  const recovery = action || notice.action
  return <div className={`ui-notice ${className}`.trim()} data-tone={notice.tone}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
    <ActionIcon name={notice.tone === 'success' ? 'check' : 'help'} />
    <div className="ui-notice-copy" role={notice.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
      {notice.title && <strong>{notice.title}</strong>}<span>{notice.message}</span>
      {notice.details && <details><summary>诊断信息</summary><p>{notice.details}</p></details>}
    </div>
    {(recovery || children || onDismiss) && <div className="ui-notice-actions">
      {recovery && <button type="button" className="btn btn-soft btn-sm" disabled={recovery.disabled} onClick={recovery.onClick}>{recovery.label}</button>}
      {children}
      {onDismiss && <button type="button" className="btn btn-ghost btn-icon" aria-label="关闭操作提示" onClick={() => onDismiss(notice.id)}><ActionIcon name="close" /></button>}
    </div>}
  </div>
}

export function ErrorNotice({ error, fallback, onRetry, retryLabel = '重试', disabled, className }) {
  return error ? <Notice notice={createNotice(error, { tone: 'error', fallback })} className={className}
    action={onRetry ? { label: retryLabel, onClick: onRetry, disabled } : undefined} /> : null
}
