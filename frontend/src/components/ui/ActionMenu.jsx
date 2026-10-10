import { Fragment, useEffect, useRef, useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import './ActionMenu.css'

export default function ActionMenu({ trigger, label, items, align = 'end', disabled = false }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const mounted = useRef(false)
  const pending = useRef(null)
  const blocked = disabled || Boolean(trigger?.props.disabled)
  const menuItems = (items || []).filter(Boolean)
  const current = useRef(null)
  current.current = { blocked, items: menuItems }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current = null }
  }, [])
  useEffect(() => { if (blocked) { pending.current = null; setOpen(false) } }, [blocked])
  const finishSelection = event => {
    const selection = pending.current
    if (!selection) return
    pending.current = null
    event.preventDefault()
    const latest = current.current
    const item = selection.id == null ? latest.items[selection.index] : latest.items.find(candidate => candidate.id === selection.id)
    const button = triggerRef.current
    if (!mounted.current || latest.blocked || !item || item.disabled || item.label !== selection.label ||
      !button?.isConnected || button.matches(':disabled') || !button.getClientRects().length) return
    button.focus({ preventScroll: true })
    if (button.ownerDocument.activeElement === button) item.onSelect?.(selection.event)
  }
  return <Menu.Root open={open} onOpenChange={next => { if (!next || !pending.current) setOpen(next) }}>
    <Menu.Trigger asChild disabled={blocked} ref={triggerRef}
      data-chroma-menu-trigger="true"
      onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
      {trigger}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className="ui-action-menu" aria-label={label || '操作菜单'}
        data-chroma-menu-content="true" align={align} sideOffset={6} collisionPadding={8}
        onCloseAutoFocus={finishSelection}
        onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}>
        {menuItems.map((item, index) => {
          if (item.type === 'label') return <Menu.Label className="ui-action-menu-label" key={item.id || `label-${index}`}>{item.label}</Menu.Label>
          if (item.type === 'separator' || (item.separator && !item.label)) return <Menu.Separator className="ui-action-menu-separator" key={item.id || `separator-${index}`} />
          return <Fragment key={item.id || index}>
            {item.separator && <Menu.Separator className="ui-action-menu-separator" />}
            <Menu.Item className="ui-action-menu-item"
            disabled={blocked || item.disabled} textValue={item.label}
            data-destructive={item.destructive || undefined}
            onSelect={event => {
              if (!mounted.current || pending.current || blocked || item.disabled || triggerRef.current?.matches(':disabled')) return
              pending.current = { id: item.id, index, label: item.label, event }
              setOpen(false)
            }}>
            <span className="ui-action-menu-text">{item.label}</span>
            {item.description && <span className="ui-action-menu-description">{item.description}</span>}
            </Menu.Item>
          </Fragment>
        })}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>
}
