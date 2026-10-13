import { useEffect, useState } from 'react'

export default function useNearViewport(ref) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (ready || !ref.current) return
    if (!globalThis.IntersectionObserver) { setReady(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setReady(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ready, ref])
  return ready
}
