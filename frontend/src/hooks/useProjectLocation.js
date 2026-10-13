import { useEffect, useRef, useState } from 'react'
import { resolveProjectLocation } from '../lib/appLocation.js'
import { restoredCreationStep } from '../lib/creationFlow.js'
import { describeError } from '../lib/notices.js'
import { listWorkspaces } from '../lib/api.js'

export default function useProjectLocation(options) {
  const { route, user, editor } = options
  const current = useRef(options)
  current.current = options
  const [pending, setPending] = useState(Boolean(route?.external && route.view === 'generate' && route.projectId))
  const [selection, setSelection] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const handled = useRef(null), request = useRef(0), publishedProject = useRef(null)
  useEffect(() => {
    if (!editor.ready) return
    if (route?.view !== 'generate' || route.external === false) { setPending(false); return }
    if (!route.external || handled.current === `${route.serial}:${attempt}`) return
    handled.current = `${route.serial}:${attempt}`
    const serial = ++request.current
    const active = () => serial === request.current && current.current.route?.serial === route.serial
    const project = editor.workspace
    const settle = (target, step = route.step || restoredCreationStep(target)) => {
      if (!active()) return
      setSelection({ workspaceId: target.id, step, serial: route.serial })
      publishedProject.current = target.id
      setPending(false)
      current.current.onLocationChange?.(target.id, step, { replace: true })
    }
    if (!route.projectId || route.projectId === project.id) {
      setError(route.invalidProject ? { message: '项目地址无效，已回到当前调色项目。' } : null)
      settle(project)
      return
    }
    if (current.current.isBusy()) {
      setError({ message: '当前操作尚未结束，请完成或取消后再切换项目。' })
      settle(project, current.current.currentStep())
      return
    }
    setPending(true); setError(null)
    void (async () => {
      try {
        current.current.beforeRestore()
        const record = await resolveProjectLocation(route.projectId, { user,
          listLocal: editor.listProjects, listRemote: listWorkspaces, deletedIds: editor.deletedProjectIds })
        if (!active()) return
        if (!record) {
          setError({ message: '地址中的项目已删除、不存在或不属于当前账号，已回到当前调色项目。' })
          settle(project, current.current.currentStep())
          return
        }
        const loaded = await current.current.loadProject(record, active)
        if (loaded && active()) settle(loaded)
      } catch (failure) {
        if (!active()) return
        setPending(false)
        setError({ message: describeError(failure, '暂时无法打开地址中的项目，当前草稿仍保留。').message,
          retry: true, projectId: project.id })
      }
    })()
    // Autosave and callback changes must not repeat a viewing request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.ready, route?.serial, attempt])
  useEffect(() => () => { ++request.current }, [])
  useEffect(() => {
    if (!editor.ready || pending || route?.view !== 'generate') return
    // A deliberate project switch supersedes an unsuccessful address request.
    if (error?.retry && error.projectId !== editor.workspace.id) {
      setError(null)
      publishedProject.current = editor.workspace.id
      current.current.onLocationChange?.(editor.workspace.id, current.current.currentStep())
      return
    }
    if (route.external || error?.retry) return
    if (publishedProject.current !== editor.workspace.id) {
      const replace = publishedProject.current === null
      publishedProject.current = editor.workspace.id
      setError(null)
      current.current.onLocationChange?.(editor.workspace.id, current.current.currentStep(), { replace })
    }
  }, [editor.ready, pending, editor.workspace.id, route?.serial, error])
  return { pending, selection, error, retry: () => setAttempt(value => value + 1), dismiss: () => {
    if (error?.retry) current.current.onLocationChange?.(editor.workspace.id, current.current.currentStep(), { replace: true })
    setError(null)
  } }
}
