import { Component, forwardRef, lazy, Suspense, useEffect, useState } from 'react'
import './FeatureLoader.css'

const failedStyles = new WeakSet()
const pendingStyles = new Map()
let styleRetrySequence = 0
const rememberStyleFailure = event => {
  if (event.target?.matches?.('link[rel="stylesheet"]')) failedStyles.add(event.target)
}
if (typeof document !== 'undefined') document.addEventListener('error', rememberStyleFailure, true)
if (import.meta.hot) import.meta.hot.dispose(() => document.removeEventListener('error', rememberStyleFailure, true))

// Vite also caches rejected stylesheet preloads. Recover the actual failed
// links before mounting a retried feature, including shared dependency styles.
async function retryFailedStyles() {
  for (const previous of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (!failedStyles.has(previous)) continue
    const next = previous.cloneNode()
    const url = new URL(previous.href)
    url.searchParams.set('chroma_retry', String(++styleRetrySequence))
    next.href = url.href
    const ready = new Promise((resolve, reject) => {
      next.onload = resolve
      next.onerror = () => reject(new Error('Stylesheet retry failed'))
    }).finally(() => pendingStyles.delete(next))
    pendingStyles.set(next, ready)
    previous.replaceWith(next)
  }
  await Promise.all(pendingStyles.values())
}

export function FeatureStatus({ title, failed = false, onRetry, onClose }) {
  return <section className={`feature-status ${failed ? 'feature-status-error' : ''}`}
    role={failed ? 'alert' : 'status'} aria-live="polite">
    <strong>{failed ? `${title}未能加载` : `正在加载${title}…`}</strong>
    {failed && <p>此功能暂时无法打开，请重试。若应用刚刚更新，保存工作后刷新页面可以载入新版本。</p>}
    {(onRetry || onClose) && <div className="feature-status-actions">
      {onRetry && <button type="button" className="btn-primary" onClick={onRetry}>重试加载</button>}
      {onClose && <button type="button" className="btn" onClick={onClose}>关闭</button>}
    </div>}
  </section>
}

function InlineSurface({ children }) { return children }

class FeatureBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    const Surface = this.props.surface || InlineSurface
    return this.state.failed
      ? <Surface onClose={this.props.onClose}><FeatureStatus title={this.props.title} failed onRetry={this.props.onRetry} onClose={this.props.onClose} /></Surface>
      : this.props.children
  }
}

// Each feature owns its boundary. Retrying replaces a rejected React.lazy instance,
// while failures in an optional tool leave the mounted editor and its photo intact.
export function lazyFeature(load, title, moduleUrl) {
  let recoveredModule
  let retrySequence = 0
  const initialLoad = () => recoveredModule ? Promise.resolve(recoveredModule) : load()
  return forwardRef(function LazyFeature({ loadingClose, loadingSurface, ...props }, ref) {
    const [attempt, setAttempt] = useState(() => ({ number: 0, View: lazy(initialLoad) }))
    const retry = () => setAttempt(current => {
      const number = current.number + 1
      const retryLoad = async () => {
        await retryFailedStyles()
        const url = new URL(moduleUrl, window.location.href)
        url.searchParams.set('chroma_retry', String(++retrySequence))
        recoveredModule = await import(/* @vite-ignore */ url.href)
        return recoveredModule
      }
      return { number, View: lazy(retryLoad) }
    })
    const View = attempt.View
    const Surface = loadingSurface || InlineSurface
    return <FeatureBoundary key={attempt.number} title={title} onRetry={retry} onClose={loadingClose} surface={loadingSurface}>
      <Suspense fallback={<Surface onClose={loadingClose}><FeatureStatus title={title} onClose={loadingClose} /></Surface>}>
        <View {...props} ref={ref} />
      </Suspense>
    </FeatureBoundary>
  })
}

// A hidden tab must not request its chunk until first use. Afterwards it stays
// mounted so reference files, import forms and in-flight work survive navigation.
export function DeferredFeature({ active, children }) {
  const [visited, setVisited] = useState(false)
  useEffect(() => { if (active) setVisited(true) }, [active])
  return active || visited ? children : null
}
