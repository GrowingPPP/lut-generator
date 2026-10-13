import Tooltip from './Tooltip.jsx'
import ActionIcon from './ActionIcon.jsx'

export default function ProtectionButton({ label, locked = false, mixed = false, disabled = false, onClick, compact = true, className = '', actionLabel, tooltipContent }) {
  const action = actionLabel || (locked && !mixed ? `解除${label}保护` : `保护${label}`)
  const state = mixed ? '部分保护' : locked ? '已保护' : '未保护'
  return <Tooltip content={tooltipContent || `${label} · ${state}。${action}；保护同时限制手动和 AI 修改。`}>
    <button type="button" className={`parameter-lock protection-button ${locked || mixed ? 'locked' : ''} ${compact ? 'is-compact' : ''} ${className}`}
      aria-label={action} aria-pressed={mixed ? 'mixed' : locked} disabled={disabled} onClick={onClick}>
      <ActionIcon name={locked || mixed ? 'lock' : 'unlock'} />
      {!compact && <span>{mixed ? '部分保护' : locked ? '已保护' : '保护'}</span>}
    </button>
  </Tooltip>
}
