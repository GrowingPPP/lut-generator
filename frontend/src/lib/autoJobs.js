import { contextSignature, parameterSignature } from './workspaceFlow.js'

export const AUTO_JOB_TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const STAGE_TITLES = {
  measure: '测量照片', optimize: '修正影调与色彩', style: '风格化',
  rules: '规则保守调整', review: '视觉复核', save: '保存报告',
}
const SKIP_TEXT = {
  goal: '当前目标跳过', locked: '可调字段已保护', no_issues: '没有需要校正的问题',
  no_client: '未启用模型', disabled: '已关闭', not_requested: '未请求',
  not_needed: '无需兜底', failed: '未能完成', no_writable_fields: '无可调字段',
  continued: '此前阶段已完成，本次保留',
  unchanged: '实际效果未变化，跳过前后改善评价',
  empty: '模型未返回有效意见，视觉复核未完成',
}
const ATTEMPT_TEXT = {
  failed: '尝试结束，未应用：模型未能完成',
  blocked: '尝试结束，未应用：候选未通过校验',
  unchanged: '尝试结束，参数没有变化',
}

export function captureAutoRequest(args) {
  return { ...args, request_id: args.request_id || crypto.randomUUID(),
    params: structuredClone(args.params), context: structuredClone(args.context) }
}

export function continuationRequest(args, completed) {
  if (completed.status !== 'succeeded' || !completed.persisted || !completed.result
      || completed.result.goal_status !== 'partially_met' || !completed.continuation_stages?.length) return null
  return captureAutoRequest({ ...args, request_id: crypto.randomUUID(),
    params: completed.result.params, continue_from: completed.id })
}

export async function ensureAutoJob(request, {
  start, get, onConnectionError = () => {}, isCurrent = () => true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  while (isCurrent()) {
    let submissionError
    try {
      const job = await start(request)
      if (job.id !== request.request_id) throw new Error('作业响应不匹配')
      return job
    } catch (error) {
      if (error.status === 409 || error.status === 410 || error.accepted === false) {
        error.confirmedNotAccepted = true
        throw error
      }
      submissionError = error
    }
    if (!isCurrent()) return null
    try {
      const existing = await get(request.request_id)
      if (existing.id !== request.request_id) throw new Error('作业响应不匹配')
      return existing
    } catch (lookupError) {
      if (!isCurrent()) return null
      if (lookupError.status === 404 && submissionError.status >= 400 && submissionError.status < 500) {
        submissionError.confirmedNotAccepted = true
        throw submissionError
      }
      onConnectionError(submissionError)
    }
    await sleep(1000)
  }
  return null
}

export function sameAutoConditions(captured, current) {
  return !!captured && captured.file === current.file && sameAutoMetadata(captured, current)
}

export function sameAutoMetadata(captured, current) {
  const frozenContext = contextSignature(captured?.context)
  return !!captured && captured.workspace_id === current.workspace_id
    && captured.source_digest === current.source_digest
    && captured.main_sample_id === current.main_sample_id
    && parameterSignature(captured.params) === parameterSignature(current.params)
    && frozenContext !== null && frozenContext === contextSignature(current.context)
}

export function bindAutoRequest(summary, current) {
  return sameAutoMetadata(summary, current) && current.file
    ? captureAutoRequest({ ...summary, file: current.file }) : null
}

export async function waitRestoredAutoJob(id, {
  get, onMissing = () => {}, onConnectionError = () => {}, isCurrent = () => true,
  resolved = () => null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  while (isCurrent()) {
    const decision = resolved()
    if (decision) return decision
    try {
      const job = await get(id)
      if (!isCurrent()) return null
      if (job.id !== id) throw new Error('作业响应不匹配')
      return job
    } catch (error) {
      if (!isCurrent()) return null
      if (error.status === 401) throw error
      if (error.status === 404) onMissing()
      else onConnectionError(error)
    }
    await sleep(1000)
  }
  return null
}

export function jobProgressSteps(job) {
  return (job?.stages || []).map((stage) => ({
    key: stage.stage, title: STAGE_TITLES[stage.stage] || '分析', state: stage.state,
    detail: stage.state === 'done' && ['optimize', 'style', 'rules'].includes(stage.stage)
      ? ATTEMPT_TEXT[stage.reason] || '尝试结束，参数已应用'
      : SKIP_TEXT[stage.reason] || (stage.round ? `第 ${stage.round} 轮` : ''),
  }))
}

export function matchingAutoResult(request, completed) {
  const result = completed?.result
  const frozenContext = contextSignature(request.context)
  return completed?.id === request.request_id && !!result?.before_params
    && result.workspace_id === (request.workspace_id || null)
    && result.source_digest === (request.source_digest || null)
    && result.main_sample_id === (request.main_sample_id || null)
    && parameterSignature(result.before_params) === parameterSignature(request.params)
    && frozenContext !== null && contextSignature(result.context) === frozenContext
}

export async function pollAutoJob(id, {
  get, onProgress = () => {}, onConnectionError = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  interval = 700, isCurrent = () => true,
} = {}) {
  let failures = 0
  while (isCurrent()) {
    try {
      const job = await get(id)
      if (!isCurrent()) return null
      if (job.id !== id) throw new Error('作业响应不匹配')
      onProgress(job)
      failures = 0
      if (AUTO_JOB_TERMINAL.has(job.status)) return job
    } catch (error) {
      if (!isCurrent()) return null
      if (error.status === 404) {
        const lost = new Error('作业已过期或服务已重启，当前草稿未应用该结果；可核对来源后重新开始')
        lost.code = 'job_lost'
        throw lost
      }
      if (error.status === 401) throw error
      failures += 1
      onConnectionError(error)
    }
    await sleep(Math.min(5000, interval * 2 ** Math.min(failures, 3)))
  }
  return null
}
