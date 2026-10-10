import { useEffect, useRef, useState } from 'react'
import { startAutoJob, getAutoJob, cancelAutoJob } from '../lib/api.js'
import { captureAutoRequest, sameAutoConditions, jobProgressSteps, pollAutoJob, ensureAutoJob, continuationRequest, matchingAutoResult } from '../lib/autoJobs.js'

export default function AutoRetouchBar({
  file, params, onResult, onBeforeRun, hasRealPhoto, running, setRunning, setStatus,
  context, workspaceId, sourceDigest, mainSampleId, sampleName, disabled,
}) {
  const [style, setStyle] = useState('')
  const [useVision, setUseVision] = useState(true)
  const [job, setJob] = useState(null)
  const [failedRequest, setFailedRequest] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [continuable, setContinuable] = useState(null)
  const activeRef = useRef(null)
  const displayWorkspaceRef = useRef(workspaceId)
  const mountedRef = useRef(true)
  const conditionsRef = useRef(null)
  conditionsRef.current = {
    file, params, context, workspace_id: workspaceId,
    source_digest: sourceDigest, main_sample_id: mainSampleId,
  }
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (activeRef.current?.id) cancelAutoJob(activeRef.current.id).catch(() => {})
      activeRef.current = null
    }
  }, [])
  useEffect(() => {
    if (!running && !activeRef.current && displayWorkspaceRef.current !== workspaceId) {
      displayWorkspaceRef.current = workspaceId
      setJob(null)
      setFailedRequest(null)
      setContinuable(null)
      setCancelling(false)
    }
  }, [workspaceId, running])
  const canRun = hasRealPhoto && !!file && !running && !disabled
    && (context?.goal_mode !== 'style_only' || !!style.trim())
  const canRetry = hasRealPhoto && !running && !disabled
    && sameAutoConditions(failedRequest?.args, conditionsRef.current)
  const canContinue = hasRealPhoto && !running && !disabled
    && sameAutoConditions(continuable, conditionsRef.current)

  const run = async (retry = null, continuing = false) => {
    if (retry ? !(continuing ? canContinue : canRetry) : !canRun) return
    const args = retry ? captureAutoRequest({ ...retry.args, request_id: crypto.randomUUID() })
      : captureAutoRequest({ ...conditionsRef.current, style, useVision })
    const token = { id: null, cancelRequested: false }
    activeRef.current = token
    setRunning(true)
    setCancelling(false)
    setFailedRequest(null)
    setContinuable(null)
    setJob(null)
    setStatus('正在提交分析请求…')
    let request = null
    try {
      request = onBeforeRun ? await onBeforeRun(args.params) : null
      if (request === false) return
      if (!sameAutoConditions(args, conditionsRef.current)) {
        setStatus('工作区、参数或主样张已变化，请用当前条件重新开始')
        return
      }
      const initial = await ensureAutoJob(args, {
        start: startAutoJob, get: getAutoJob,
        isCurrent: () => mountedRef.current && activeRef.current === token,
        onConnectionError: () => setStatus('提交响应未确认，编辑保持冻结；正在按同一请求标识恢复作业'),
      })
      if (!initial) return
      token.id = initial.id
      if (!mountedRef.current || activeRef.current !== token) {
        cancelAutoJob(initial.id).catch(() => {})
        return
      }
      setJob(initial)
      const completed = await pollAutoJob(initial.id, {
        get: getAutoJob,
        isCurrent: () => mountedRef.current && activeRef.current === token,
        onProgress: (next) => {
          setJob(next)
          if (next.status === 'cancelling' || token.cancelRequested)
            setStatus(next.can_cancel === false && next.status !== 'cancelling'
              ? '分析已完成，正在保存；取消未生效，请等待最终状态'
              : '正在取消，等待当前调用返回并确认候选未保存、未应用…')
          else setStatus(next.status === 'queued' ? '等待开始分析…' : '正在执行分析，可查看真实阶段进度')
        },
        onConnectionError: () => setStatus(token.cancelRequested
          ? '正在取消，但连接中断；尚未确认服务端终态，正在重新查询'
          : '连接中断，尚未确认作业结束；正在重新查询，编辑保持冻结'),
      })
      if (!completed) return
      if (completed.status === 'cancelled') {
        setStatus('已取消，候选未保存、未应用，当前草稿保持原状')
        return
      }
      if (completed.status === 'failed') {
        setFailedRequest({ args, request })
        setStatus(completed.error?.message || '本次分析未完成，可核对来源后重试原请求')
        return
      }
      if (!completed.persisted || !completed.result) throw new Error('结果尚未确认保存，本次未应用')
      if (!matchingAutoResult(args, completed)) throw new Error('结果与冻结请求的来源、参数或上下文不一致，本次未应用')
      if (!sameAutoConditions(args, conditionsRef.current)) {
        setStatus('工作区、参数或主样张已变化，本次结果未应用')
        return
      }
      const applied = await onResult(completed.result, request)
      if (applied !== false) setContinuable(continuationRequest(args, completed))
      if (applied !== false) setStatus(token.cancelRequested
        ? '分析已完成并保存，取消未生效；结果已应用，可查看报告与撤销'
        : completed.result.blocked_reasons?.length
          ? `已完成本次分析：${completed.result.blocked_reasons.join('；')}`
          : '已完成本次调整，可查看报告与撤销')
    } catch (error) {
      if (!mountedRef.current || activeRef.current !== token) return
      setFailedRequest({ args, request })
      setStatus(error.message)
    } finally {
      if (mountedRef.current && activeRef.current === token) {
        activeRef.current = null
        setCancelling(false)
        setRunning(false)
      }
    }
  }
  const cancel = async () => {
    const token = activeRef.current
    if (!token?.id || cancelling) return
    token.cancelRequested = true
    setCancelling(true)
    setStatus('正在取消，等待服务端确认…')
    try {
      const next = await cancelAutoJob(token.id)
      if (mountedRef.current && activeRef.current === token) setJob(next)
    } catch (error) {
      if (mountedRef.current && activeRef.current === token)
        setStatus(error.status === 404
          ? '作业已失效，正在核对最终状态；这不表示取消成功'
          : '取消尚未确认，正在重新查询；编辑保持冻结')
    }
  }
  const steps = jobProgressSteps(job)
  const head = cancelling || job?.status === 'cancelling' ? '正在取消…'
    : job?.progress?.stage === 'save' && job.progress.state === 'running' ? '正在保存，不能取消…'
    : job?.status === 'queued' ? '等待分析…'
      : job?.status === 'succeeded' ? '本次分析已结束'
        : job?.status === 'failed' ? '本次分析未完成'
          : job?.status === 'cancelled' ? '已确认取消' : '正在分析照片…'
  return (
    <>
      <div className="auto-bar">
        <span className="auto-bar-icon" aria-hidden="true">✦</span>
        <input className="auto-style-input" value={style} onChange={(e) => setStyle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canRun) run() }}
          placeholder={context?.goal_mode === 'style_only' ? '请输入风格描述，例如日系清透一点' : '风格(可选):日系清透一点'}
          maxLength={200} disabled={running || disabled} aria-label="风格描述" />
        <button type="button" className="btn-primary auto-go" onClick={() => run()}
          disabled={!canRun} title={hasRealPhoto ? '' : '请先上传样张'}>
          {running ? '修图中…' : 'AI 自动修图'}
        </button>
        {running && <button type="button" className="btn" onClick={cancel}
          disabled={!job?.can_cancel || cancelling} title={job?.progress?.stage === 'save' ? '保存已开始，不能取消' : ''}>
          {cancelling ? '正在取消…' : job?.progress?.stage === 'save' ? '正在保存…' : '取消分析'}</button>}
        <label className="auto-vision" title="开启后会把照片与修图结果发送给模型做主观复检。关闭后只根据客观数据调整。">
          <input type="checkbox" checked={useVision} onChange={(e) => setUseVision(e.target.checked)} disabled={running || disabled} />
          <span>视觉复核</span>
        </label>
      </div>
      {failedRequest && <p className="workspace-note">
        <button type="button" className="btn" disabled={!canRetry} onClick={() => run(failedRequest)}>重试原请求</button>
        {canRetry ? ' 使用原参数、目标、保护项、风格与主样张重新开始。'
          : ' 参数或来源已变化；请核对当前条件后重新开始。'}
      </p>}
      {continuable && <p className="workspace-note">
        <button type="button" className="btn" disabled={!canContinue} onClick={() => run({ args: continuable }, true)}>继续未完成阶段</button>
        {canContinue ? ' 从已应用的正式候选继续尝试；已完成阶段保留，本次另建可撤销操作。'
          : ' 已应用候选或来源已变化，不能继续原阶段。'}
      </p>}
      <p className="text-muted">开启视觉复核会将照片与调色预览发送给模型；关闭后只发送统计数据。上传的照片不会保存在本系统中。</p>
      <p className="workspace-note">AI 分析主样张：{sampleName || '尚未选择'}{hasRealPhoto ? '' : ' · 请确认输入并绑定原文件'}</p>
      {job && <div className="auto-progress" aria-live="polite">
        <div className="auto-progress-head"><span className="auto-spinner" aria-hidden="true">{running ? '◐' : '·'}</span><span>{head}</span></div>
        <ol className="auto-progress-plan">{steps.map((step) => <li key={step.key} className={`auto-step ${step.state}`}>
          <span className="auto-step-mark">{step.state === 'done' ? '✓' : step.state === 'running' ? '◐' : step.state === 'skipped' ? '–' : '·'}</span>
          <span className="auto-step-title">{step.title}</span><span className="auto-step-detail">{step.detail}</span>
        </li>)}</ol>
      </div>}
    </>
  )
}
