import { useEffect, useRef, useState } from 'react'
import { startAutoJob, getAutoJob, cancelAutoJob } from '../lib/api.js'
import { captureAutoRequest, sameAutoConditions, sameAutoMetadata, bindAutoRequest, jobProgressSteps,
  pollAutoJob, ensureAutoJob, continuationRequest, matchingAutoResult, waitRestoredAutoJob,
  AUTO_JOB_TERMINAL } from '../lib/autoJobs.js'
import { createAutoJobStorage } from '../lib/autoJobStorage.js'

export default function AutoRetouchBar({
  file, params, onResult, onBeforeRun, onRestoreResult, getAppliedJob,
  userId, workspaceReady = true, hasRealPhoto, running, setRunning, setStatus,
  context, workspaceId, sourceDigest, mainSampleId, sampleName, disabled, jobStorage,
}) {
  const [style, setStyle] = useState('')
  const [useVision, setUseVision] = useState(true)
  const [job, setJob] = useState(null)
  const [failedRequest, setFailedRequest] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [continuable, setContinuable] = useState(null)
  const [recoveryMissing, setRecoveryMissing] = useState(false)
  const [recoveryChecked, setRecoveryChecked] = useState(false)
  const activeRef = useRef(null)
  const restoreGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const conditionsRef = useRef(null)
  const callbacksRef = useRef(null)
  const storageRef = useRef(jobStorage || createAutoJobStorage())
  const ownerRef = useRef(userId)
  ownerRef.current = userId
  callbacksRef.current = { onResult, onRestoreResult, getAppliedJob, setRunning, setStatus }
  conditionsRef.current = {
    file, params, context, workspace_id: workspaceId,
    source_digest: sourceDigest, main_sample_id: mainSampleId,
  }
  const current = (token) => mountedRef.current && activeRef.current === token
    && String(ownerRef.current) === String(token.userId)
    && conditionsRef.current.workspace_id === token.workspaceId
  const patchReceipt = (token, patch) => storageRef.current.update(token.userId, token.workspaceId, token.id, patch)
  const showProgress = (token, next) => {
    if (!current(token)) return
    setJob(next)
    if (next.status === 'cancelling' || token.cancelRequested)
      callbacksRef.current.setStatus(next.can_cancel === false && next.status !== 'cancelling'
        ? '分析已完成，正在保存；取消未生效，请等待最终状态'
        : '正在取消，等待当前调用返回并确认候选未保存、未应用…')
    else callbacksRef.current.setStatus(next.status === 'queued' ? '等待开始分析…' : '正在执行分析，可查看真实阶段进度')
  }
  const waitForKnownJob = async (token) => waitRestoredAutoJob(token.id, {
    get: id => getAutoJob(id, token.workspaceId), isCurrent: () => current(token),
    resolved: () => token.resolvedJob,
    onMissing: () => {
      setRecoveryMissing(true)
      callbacksRef.current.setStatus('暂未找到作业，编辑保持冻结；原提交可能尚未登记、已失效或服务已重启。可继续等待或明确结束未确认提交')
    },
    onConnectionError: () => callbacksRef.current.setStatus('恢复查询尚未确认作业终态，编辑保持冻结；正在重新查询'),
  })
  const watch = async (token, initial) => {
    let known = initial
    while (known && current(token)) {
      setRecoveryMissing(false)
      showProgress(token, known)
      if (AUTO_JOB_TERMINAL.has(known.status)) return known
      try {
        return await pollAutoJob(token.id, {
          get: id => getAutoJob(id, token.workspaceId), isCurrent: () => current(token),
          onProgress: next => showProgress(token, next),
          onConnectionError: () => callbacksRef.current.setStatus('连接中断，尚未确认作业结束；正在重新查询，编辑保持冻结'),
        })
      } catch (error) {
        if (error.code !== 'job_lost') throw error
        known = await waitForKnownJob(token)
      }
    }
    return null
  }
  const finish = async (token, args, completed, request, restoring) => {
    if (!current(token)) return
    setJob(completed)
    await patchReceipt(token, { state: 'terminal', job: completed })
    if (!current(token)) return
    if (completed.status === 'cancelled') {
      await patchReceipt(token, { state: 'resolved' })
      callbacksRef.current.setStatus(completed.not_accepted
        ? '未确认提交已明确结束，后续提交已阻止；当前草稿未应用该结果'
        : '已取消，候选未保存、未应用，当前草稿保持原状')
      return
    }
    if (completed.status === 'failed') {
      setFailedRequest({ args, request, restored: restoring })
      callbacksRef.current.setStatus(completed.error?.message || '本次分析未完成，可核对来源后重试原请求')
      return
    }
    if (!completed.persisted || !completed.result) throw new Error('结果尚未确认保存，本次未应用')
    if (callbacksRef.current.getAppliedJob?.(token.id)) {
      await patchReceipt(token, { state: 'applied', applied: true })
      setContinuable(continuationRequest(args, completed))
      callbacksRef.current.setStatus('已恢复本次作业状态；该结果此前已应用，不会再次写入草稿或撤销历史')
      return
    }
    if (!matchingAutoResult(args, completed) || completed.result.job_id !== token.id)
      throw new Error('结果与冻结请求的来源、参数或上下文不一致，本次未应用')
    if (!(restoring ? sameAutoMetadata(args, conditionsRef.current) : sameAutoConditions(args, conditionsRef.current))) {
      await patchReceipt(token, { state: 'conflict', message: '当前草稿或来源已变化' })
      callbacksRef.current.setStatus('作业已保存，但当前草稿、上下文或主样张来源已变化；恢复候选未应用，可查看历史报告')
      return
    }
    const meta = { jobId: token.id, requestSummary: token.summary || args }
    const applied = restoring
      ? await callbacksRef.current.onRestoreResult?.(completed.result, meta)
      : await callbacksRef.current.onResult(completed.result, request, meta)
    if (applied !== false && applied !== undefined && current(token)) {
      await patchReceipt(token, { state: 'applied', applied: true })
      setContinuable(continuationRequest(args, completed))
      callbacksRef.current.setStatus(token.cancelRequested
        ? '分析已完成并保存，取消未生效；结果已应用，可查看报告与撤销'
        : completed.result.blocked_reasons?.length
          ? `已完成本次分析：${completed.result.blocked_reasons.join('；')}`
          : restoring ? '已恢复并应用已保存候选，无需原文件；再次分析前需重新绑定原文件' : '已完成本次调整，可查看报告与撤销')
    } else if (current(token)) {
      await patchReceipt(token, { state: 'conflict', message: '候选未应用或草稿未确认保存' })
      callbacksRef.current.setStatus('候选已保存，但未确认应用或本机保存；请查看草稿提示与历史报告')
    }
  }
  const release = (token) => {
    if (!current(token)) return
    activeRef.current = null
    setRecoveryMissing(false)
    setCancelling(false)
    callbacksRef.current.setRunning(false)
  }
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; activeRef.current = null }
  }, [])
  useEffect(() => {
    if (!workspaceReady || !userId || userId === 'guest') return undefined
    const generation = ++restoreGenerationRef.current
    const token = { id: null, userId, workspaceId, cancelRequested: false, restoring: true }
    activeRef.current = token
    setRecoveryChecked(false)
    setJob(null)
    setFailedRequest(null)
    setContinuable(null)
    setRecoveryMissing(false)
    setCancelling(false)
    callbacksRef.current.setRunning(true)
    const restore = async () => {
      let receipt
      try {
        receipt = await storageRef.current.load(userId, workspaceId)
        if (!current(token)) return
        if (!receipt || ['resolved', 'conflict', 'rejected'].includes(receipt.state)) { release(token); return }
        token.id = receipt.request_id
        token.summary = receipt.request
        token.cancelRequested = receipt.cancel_requested
        setStyle(receipt.request.style || '')
        setUseVision(receipt.request.useVision)
        if (receipt.applied || callbacksRef.current.getAppliedJob?.(token.id)) {
          if (receipt.job) {
            setJob(receipt.job)
            setContinuable(continuationRequest(receipt.request, receipt.job))
          }
          release(token)
          return
        }
        callbacksRef.current.setStatus('正在恢复本工作区的 AI 作业，编辑保持冻结…')
        const initial = await waitForKnownJob(token)
        const completed = await watch(token, initial)
        if (completed) await finish(token, receipt.request, completed, null, true)
        release(token)
      } catch (error) {
        if (!current(token)) return
        callbacksRef.current.setStatus(receipt
          ? `已确认的候选未应用：${error.message}`
          : `无法读取本机作业记录，编辑保持冻结：${error.message}；请修复存储后刷新`)
        if (receipt) release(token)
      } finally {
        if (mountedRef.current && restoreGenerationRef.current === generation
            && String(ownerRef.current) === String(userId) && conditionsRef.current.workspace_id === workspaceId)
          setRecoveryChecked(true)
      }
    }
    void restore()
    return () => {
      if (restoreGenerationRef.current === generation) restoreGenerationRef.current += 1
      if (activeRef.current === token) activeRef.current = null
    }
  }, [userId, workspaceId, workspaceReady])
  const canRun = recoveryChecked && hasRealPhoto && !!file && !running && !disabled
    && (context?.goal_mode !== 'style_only' || !!style.trim())
  const retryArgs = bindAutoRequest(failedRequest?.args, conditionsRef.current)
  const continueArgs = bindAutoRequest(continuable, conditionsRef.current)
  const canRetry = recoveryChecked && hasRealPhoto && !running && !disabled && !!retryArgs
  const canContinue = recoveryChecked && hasRealPhoto && !running && !disabled && !!continueArgs

  const run = async (retry = null, continuing = false) => {
    if (retry ? !(continuing ? canContinue : canRetry) : !canRun) return
    const original = retry ? bindAutoRequest(retry.args, conditionsRef.current) : conditionsRef.current
    const args = captureAutoRequest({ ...original, request_id: crypto.randomUUID(),
      ...(retry ? {} : { style, useVision }) })
    const token = { id: args.request_id, userId, workspaceId, cancelRequested: false }
    activeRef.current = token
    setRunning(true)
    setCancelling(false)
    setFailedRequest(null)
    setContinuable(null)
    setJob(null)
    setStatus('正在保存请求摘要并提交分析…')
    let request = null, submitted = false, receiptSaved = false
    try {
      request = onBeforeRun ? await onBeforeRun(args.params) : null
      if (request === false || !current(token)) return
      if (!sameAutoConditions(args, conditionsRef.current)) {
        setStatus('工作区、参数或主样张已变化，请用当前条件重新开始')
        return
      }
      const receipt = await storageRef.current.begin(userId, args)
      token.summary = receipt.request
      receiptSaved = true
      if (!current(token)) return
      submitted = true
      const initial = await ensureAutoJob(args, {
        start: startAutoJob, get: id => getAutoJob(id, workspaceId), isCurrent: () => current(token),
        onConnectionError: () => setStatus('提交响应未确认，编辑保持冻结；正在按同一请求标识恢复作业'),
      })
      if (!initial || !current(token)) return
      await patchReceipt(token, { state: 'accepted' }).catch(() => {
        if (current(token)) setStatus('请求已提交，本机状态更新失败；仍按已保存标识等待服务端终态，编辑保持冻结')
      })
      const completed = await watch(token, initial)
      if (completed) await finish(token, args, completed, request, false)
    } catch (error) {
      if (!current(token)) return
      if (receiptSaved && (!submitted || error.confirmedNotAccepted))
        await patchReceipt(token, { state: 'rejected', message: error.message }).catch(() => {})
      setFailedRequest({ args, request })
      setStatus(error.message)
    } finally { release(token) }
  }
  const cancel = async () => {
    const token = activeRef.current
    if (!token?.id || cancelling) return
    token.cancelRequested = true
    setCancelling(true)
    setStatus(recoveryMissing ? '正在确认结束未登记提交…' : '正在取消，等待服务端确认…')
    try {
      await patchReceipt(token, { cancel_requested: true }).catch(() => {})
      const next = await cancelAutoJob(token.id, { workspaceId: token.workspaceId, preventLate: recoveryMissing })
      if (current(token)) {
        setJob(next)
        if (recoveryMissing) token.resolvedJob = next
      }
    } catch (error) {
      if (current(token)) {
        setCancelling(false)
        setStatus('取消或结束尚未确认，编辑保持冻结；正在重新查询')
      }
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
          disabled={(!recoveryMissing && !job?.can_cancel) || cancelling} title={job?.progress?.stage === 'save' ? '保存已开始，不能取消' : ''}>
          {cancelling ? '正在取消…' : recoveryMissing ? '结束未确认提交' : job?.progress?.stage === 'save' ? '正在保存…' : '取消分析'}</button>}
        <label className="auto-vision" title="开启后会把照片与修图结果发送给模型做主观复检。关闭后只根据客观数据调整。">
          <input type="checkbox" checked={useVision} onChange={(e) => setUseVision(e.target.checked)} disabled={running || disabled} />
          <span>视觉复核</span>
        </label>
      </div>
      {failedRequest && <p className="workspace-note">
        <button type="button" className="btn" disabled={!canRetry} onClick={() => run(failedRequest)}>重试原请求</button>
        {canRetry ? ' 使用原参数、目标、保护项、风格与主样张重新开始。'
          : ' 参数或来源已变化，或尚未绑定原文件；请核对当前条件后重新开始。'}
      </p>}
      {continuable && <p className="workspace-note">
        <button type="button" className="btn" disabled={!canContinue} onClick={() => run({ args: continuable }, true)}>继续未完成阶段</button>
        {canContinue ? ' 从已应用的正式候选继续尝试；已完成阶段保留，本次另建可撤销操作。'
          : ' 已应用候选或来源已变化，或尚未绑定原文件，不能继续原阶段。'}
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
