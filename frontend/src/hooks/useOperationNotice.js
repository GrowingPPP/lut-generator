import { useCallback, useEffect, useRef, useState } from 'react'
import { createNotice, noticeForScope } from '../lib/notices.js'

export default function useOperationNotice(scopeId) {
  const [value, setValue] = useState(null)
  const sequence = useRef(0)
  const currentScope = useRef(scopeId)
  currentScope.current = scopeId
  useEffect(() => { setValue(current => current?.scopeId === scopeId ? current : null) }, [scopeId])
  const notify = useCallback((message, options) => {
    if (currentScope.current !== scopeId) return
    setValue(message ? createNotice(message, options, scopeId, ++sequence.current) : null)
  }, [scopeId])
  const dismiss = useCallback(id => setValue(current => current?.id === id ? null : current), [])
  return { notice: noticeForScope(value, scopeId), notify, dismiss }
}
