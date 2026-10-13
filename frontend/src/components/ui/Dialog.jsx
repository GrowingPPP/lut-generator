import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import './Dialog.css'
import { ErrorNotice } from './Notice.jsx'

const DialogsContext = createContext(null)
const OPEN_CHILD_LAYER = '[data-chroma-select-trigger][data-state="open"], [data-chroma-popover-trigger][data-state="open"], [data-chroma-menu-trigger][data-state="open"]'

function assignRef(ref, node) {
  if (typeof ref === 'function') ref(node)
  else if (ref) ref.current = node
}

function panelTitle(panel) {
  if (panel.props['aria-label']) return panel.props['aria-label']
  function heading(nodes) {
    for (const node of Children.toArray(nodes)) {
      if (!isValidElement(node)) continue
      if (typeof node.type === 'string' && /^h[1-6]$/.test(node.type)) return node.props.children
      const nested = heading(node.props.children)
      if (nested) return nested
    }
    return null
  }
  return heading(panel.props.children) || '对话框'
}

function Surface({ children, onClose, open = true, busy = false, initialFocusRef,
  contentRef, returnFocusRef, overlayClassName = 'modal-backdrop', destructive = false }) {
  const panel = Children.only(children)
  const Primitive = destructive ? AlertDialog : Dialog
  const localRef = useRef(null)
  const returnFocus = useRef(null)
  const previousOpen = useRef(false)
  const closeRef = useRef({ onClose, busy })
  closeRef.current = { onClose, busy }
  const ref = useCallback(node => {
    localRef.current = node
    assignRef(contentRef, node)
    assignRef(panel.ref, node)
  }, [contentRef, panel.ref])

  useEffect(() => {
    const content = localRef.current
    if (!open || !busy || !content) return
    const active = document.activeElement
    if (!content.contains(active) || active.matches?.(':disabled')) content.focus({ preventScroll: true })
  }, [busy, open])

  const requestClose = () => {
    if (!closeRef.current.busy) closeRef.current.onClose?.()
  }
  const hasChildLayer = () => !!localRef.current?.querySelector(OPEN_CHILD_LAYER)
  const escape = event => {
    if (event.defaultPrevented) return
    const activeEdit = event.target.closest?.('[data-chroma-escape-cancel="true"]') ||
      localRef.current?.querySelector('[data-chroma-escape-gesture="true"]')
    if (closeRef.current.busy || hasChildLayer() || activeEdit) event.preventDefault()
  }
  const outside = event => {
    if (closeRef.current.busy || hasChildLayer()) event.preventDefault()
  }
  const autofocus = event => {
    if (!previousOpen.current) returnFocus.current = returnFocusRef?.current || document.activeElement
    previousOpen.current = true
    const target = initialFocusRef?.current
    if (target && !target.matches?.(':disabled')) {
      event.preventDefault()
      target.focus({ preventScroll: true })
    } else if (destructive || closeRef.current.busy) {
      event.preventDefault()
      localRef.current?.focus({ preventScroll: true })
    }
  }
  const restoreFocus = event => {
    event.preventDefault()
    previousOpen.current = false
    const target = returnFocus.current
    const remaining = Array.from(document.querySelectorAll('[data-chroma-dialog-content][data-state="open"]')).at(-1)
    if (remaining && !remaining.contains(target)) return
    if (target?.isConnected && !target.matches?.(':disabled') && target.getClientRects().length) target.focus({ preventScroll: true })
  }
  const child = cloneElement(panel, {
    ref,
    tabIndex: panel.props.tabIndex ?? -1,
    ...(destructive ? { role: 'alertdialog' } : {}),
    children: <>
      {!panel.props['aria-label'] && !panel.props['aria-labelledby'] &&
        <Primitive.Title className="dialog-visually-hidden">{panelTitle(panel)}</Primitive.Title>}
      {panel.props.children}
    </>,
  })
  const naming = panel.props['aria-label'] ? { 'aria-labelledby': undefined }
    : panel.props['aria-labelledby'] ? { 'aria-labelledby': panel.props['aria-labelledby'] } : {}

  return <Primitive.Root open={open} onOpenChange={next => { if (!next) requestClose() }}>
    <Primitive.Portal>
      <Primitive.Overlay className={overlayClassName} data-chroma-dialog-overlay="true">
        <Primitive.Content asChild data-chroma-dialog-content="true"
          {...naming}
          aria-describedby={panel.props['aria-describedby']}
          onOpenAutoFocus={autofocus} onCloseAutoFocus={restoreFocus}
          onEscapeKeyDown={escape} onPointerDownOutside={outside} onInteractOutside={outside}>
          {child}
        </Primitive.Content>
      </Primitive.Overlay>
    </Primitive.Portal>
  </Primitive.Root>
}

export function ModalSurface(props) { return <Surface {...props} /> }
export function AlertSurface(props) { return <Surface {...props} destructive /> }

function DialogRequest({ request, settle }) {
  const id = useId()
  const inputRef = useRef(null)
  const cancelRef = useRef(null)
  const [value, setValue] = useState(request.options.defaultValue || '')
  const [error, setError] = useState('')
  const isPrompt = request.type === 'prompt'
  const options = request.options
  const destructive = !isPrompt && !!options.destructive
  const SurfaceComponent = destructive ? AlertSurface : ModalSurface
  const cancel = () => settle(request, isPrompt ? null : false)
  const confirm = event => {
    event?.preventDefault()
    if (isPrompt && !value.trim()) {
      setError('请输入名称，不能只填空格。')
      inputRef.current?.focus()
      return
    }
    settle(request, isPrompt ? value.trim() : true)
  }
  return <SurfaceComponent onClose={cancel} initialFocusRef={isPrompt ? inputRef : cancelRef}>
    <section className="workspace-modal dialog-request" aria-labelledby={`${id}-title`}
      aria-describedby={options.description ? `${id}-description` : undefined}>
      <h2 id={`${id}-title`}>{options.title || (isPrompt ? '修改名称' : '确认操作')}</h2>
      {options.description && <p id={`${id}-description`} className="dialog-request-description">{options.description}</p>}
      <form onSubmit={confirm} noValidate>
        {isPrompt && <label className="dialog-prompt-label" htmlFor={`${id}-input`}>
          {options.label || '名称'}
          <input id={`${id}-input`} ref={inputRef} value={value} maxLength={options.maxLength ?? 100}
            aria-required="true" aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
            onChange={event => { setValue(event.target.value); setError('') }} />
        </label>}
        {error && <div id={`${id}-error`}><ErrorNotice error={error} /></div>}
        <div className="modal-actions">
          <button type="button" ref={cancelRef} className="btn btn-ghost" onClick={cancel}>{options.cancelLabel || '取消'}</button>
          <button type="submit" className={destructive ? 'btn-danger btn-danger-primary' : 'btn-primary'}>{options.confirmLabel || (isPrompt ? '保存' : '确认')}</button>
        </div>
      </form>
    </section>
  </SurfaceComponent>
}

export function DialogProvider({ children }) {
  const [request, setRequest] = useState(null)
  const active = useRef(null)
  const enqueue = useCallback((type, options) => new Promise(resolve => {
    if (active.current) { resolve(type === 'prompt' ? null : false); return }
    const next = { id: crypto.randomUUID(), type, options, resolve }
    active.current = next
    setRequest(next)
  }), [])
  const value = useMemo(() => ({
    confirm: options => enqueue('confirm', options),
    prompt: options => enqueue('prompt', options),
  }), [enqueue])
  const settle = useCallback((request, result) => {
    if (active.current !== request) return
    active.current = null
    setRequest(null)
    request.resolve(result)
  }, [])
  useEffect(() => {
    const cancel = () => {
      const pending = active.current
      active.current = null
      pending?.resolve(pending.type === 'prompt' ? null : false)
      setRequest(null)
    }
    window.addEventListener('chroma:unauthorized', cancel)
    return () => {
      window.removeEventListener('chroma:unauthorized', cancel)
      const pending = active.current
      active.current = null
      pending?.resolve(pending.type === 'prompt' ? null : false)
    }
  }, [])
  return <DialogsContext.Provider value={value}>
    {children}
    {request && <DialogRequest key={request.id} request={request} settle={settle} />}
  </DialogsContext.Provider>
}

export function useDialogs() {
  const dialogs = useContext(DialogsContext)
  if (!dialogs) throw new Error('useDialogs 需要在 DialogProvider 中使用')
  return dialogs
}
