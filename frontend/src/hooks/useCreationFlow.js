import { useCallback, useEffect, useState } from 'react'
import { isCreationStep, restoredCreationStep } from '../lib/creationFlow.js'

export default function useCreationFlow({ workspace, ready, beforeNavigate }) {
  const [selection, setSelection] = useState(null)
  useEffect(() => {
    if (!ready) {
      setSelection(current => current ? { ...current, ready: false } : null)
      return
    }
    // Seed once per restored project. Uploads and reports must not navigate
    // away from the active step while the user is confirming their photo.
    setSelection(current => current?.workspaceId === workspace.id && current.ready
      ? current : { workspaceId: workspace.id, step: restoredCreationStep(workspace), ready: true })
  }, [workspace.id, ready])
  const step = selection?.workspaceId === workspace.id && (!ready || selection.ready)
    ? selection.step : restoredCreationStep(workspace)
  const navigate = useCallback(next => {
    if (!ready || !isCreationStep(next)) return false
    beforeNavigate?.()
    setSelection({ workspaceId: workspace.id, step: next, ready: true })
    return true
  }, [workspace.id, ready, beforeNavigate])
  return { step, navigate }
}
