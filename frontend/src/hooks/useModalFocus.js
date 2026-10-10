import { useEffect, useRef } from 'react'

export default function useModalFocus(onClose, allowClose = true, active = true) {
  const ref = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return undefined
    const previous = document.activeElement
    const panel = ref.current
    const controls = () =>
      [
        ...(panel?.querySelectorAll(
          'button, input, select, textarea, a[href], details > summary, [tabindex]',
        ) || []),
      ].filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') &&
        node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length > 0)
    controls()[0]?.focus()
    function onKey(event) {
      if (event.defaultPrevented || panel?.querySelector('[data-chroma-select-trigger][data-state="open"]')) return
      if (event.key === 'Escape' && allowClose) {
        event.preventDefault()
        close.current()
      }
      if (event.key !== 'Tab') return
      const items = controls(),
        first = items[0],
        last = items.at(-1)
      if (!first) {
        event.preventDefault()
        return
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [allowClose, active])
  return ref
}
