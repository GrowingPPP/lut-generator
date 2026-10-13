import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import './HelpPopover.css'

export default function HelpPopover({
  trigger, title, children, open, defaultOpen = false, onOpenChange,
  side = 'bottom', align = 'start', describedBy, className = '', hoverable = false,
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const hoverOnly = useRef(false)
  const returnFocus = useRef(true)
  const timer = useRef(null)
  const content = useRef(null)
  const current = open === undefined ? localOpen : open
  const clearTimer = () => { clearTimeout(timer.current); timer.current = null }
  useEffect(() => () => clearTimeout(timer.current), [])
  const change = next => {
    clearTimer()
    if (!next) hoverOnly.current = false
    if (open === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }
  const peek = event => {
    if (!hoverable || event.pointerType !== 'mouse') return
    clearTimer()
    if (!current) timer.current = setTimeout(() => {
      hoverOnly.current = true
      returnFocus.current = false
      change(true)
    }, 250)
  }
  const leave = () => {
    clearTimer()
    if (hoverOnly.current) timer.current = setTimeout(() => {
      if (!content.current?.contains(document.activeElement)) change(false)
    }, 180)
  }
  const pin = event => {
    clearTimer()
    // Clicking a hover preview pins it for reading instead of toggling it shut.
    if (current && hoverOnly.current) event.preventDefault()
    hoverOnly.current = false
    returnFocus.current = true
  }
  return <Popover.Root open={current} onOpenChange={change} modal={false}>
    <Popover.Trigger asChild data-chroma-popover-trigger="true"
      onPointerEnter={peek} onPointerLeave={leave} onClick={pin}
      onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>{trigger}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className={`ui-help-popover ${className}`.trim()}
        data-chroma-popover-content="true" side={side} align={align} sideOffset={8}
        collisionPadding={8} aria-describedby={describedBy} ref={content}
        onPointerEnter={clearTimer} onPointerLeave={leave}
        onOpenAutoFocus={event => { if (hoverOnly.current) event.preventDefault() }}
        onCloseAutoFocus={event => { if (!returnFocus.current) event.preventDefault() }}
        onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); change(false) }}>
        <div className="ui-help-popover-heading">
          <Popover.Title className="ui-help-popover-title">{title}</Popover.Title>
          <Popover.Close className="ui-help-popover-close" aria-label="关闭使用说明">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </Popover.Close>
        </div>
        <div className="ui-help-popover-body" tabIndex={0} role="region" aria-label="说明正文">{children}</div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
