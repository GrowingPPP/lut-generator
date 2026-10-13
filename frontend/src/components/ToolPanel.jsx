import { forwardRef, useEffect, useId, useRef, useState } from 'react'

const ToolPanel = forwardRef(function ToolPanel({ children, step, minimized = false, onExpand, ...props }, ref) {
  const [mobile, setMobile] = useState(false)
  const [size, setSize] = useState('basic')
  const id = useId()
  const panel = useRef(null)
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 740px)')
    if (!query) return undefined
    const update = () => setMobile(query.matches)
    update(); query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  const docked = mobile && ['style', 'adjust'].includes(step)
  const visibleSize = minimized ? 'closed' : size
  const choose = next => { if (minimized) onExpand?.(); setSize(next) }
  useEffect(() => {
    if (!docked || visibleSize === 'closed') return undefined
    const revealFocus = event => {
      const target = event.target
      if (!panel.current || panel.current.contains(target) || !target?.getBoundingClientRect) return
      const rect = target.getBoundingClientRect(), top = panel.current.getBoundingClientRect().top
      // Step announcements receive focus but have no visible hit area to reveal.
      if (target === document.body || rect.width < 2 || rect.height < 2) return
      if (rect.bottom > top && rect.top < window.innerHeight) {
        const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2))
        const y = Math.min(window.innerHeight - 1, Math.max(top + 1, rect.top))
        // Floating notices and dialogs are already above the dock. Only reveal
        // a focused page control when the dock actually covers its position.
        if (panel.current.contains(document.elementFromPoint(x, y))) setSize('closed')
      }
    }
    window.addEventListener('focusin', revealFocus)
    return () => window.removeEventListener('focusin', revealFocus)
  }, [docked, visibleSize])
  return <aside {...props} ref={node => {
    panel.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }} data-mobile-panel={docked ? visibleSize : undefined}>
    <div className="mobile-tool-heading">
      <strong>{step === 'style' ? '定风格' : '调效果'}</strong>
      <div role="group" aria-label="调色面板大小">
        {['closed', 'basic', 'expanded'].map((value, index) => <button key={value} type="button"
          className={`btn btn-sm ${visibleSize === value ? 'btn-soft' : 'btn-ghost'}`}
          aria-pressed={visibleSize === value} aria-controls={id} onClick={() => choose(value)}>
          {['收起', '基础', '展开'][index]}
        </button>)}
      </div>
    </div>
    <div className="task-panel-content" id={id} inert={docked && visibleSize === 'closed' ? '' : undefined}>
      {children}
    </div>
  </aside>
})

export default ToolPanel
