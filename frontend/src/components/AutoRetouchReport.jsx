import {
  diffParams,
  gradeHeadline,
  rejectionList,
  reviewSkipText,
  styleDiff,
} from '../lib/autoGrade.js'
import { contextSignature } from '../lib/workspaceFlow.js'
import { normalizeSubjectMode, SUBJECT_MODE_LABELS } from '../lib/samples.js'

const GOAL_LABELS = {
  natural: '自然校正',
  preserve: '保留氛围',
  style_only: '只调整风格',
}

export default function AutoRetouchReport({ result, beforeParams, onUndo, historical, applied }) {
  if (!result) return null

  const changes = diffParams(beforeParams, result.params)
  const styleApplied = result.style_applied
    ? styleDiff(result.style_applied_params || result.style_params)
    : []
  const styleBlocked =
    !result.style_applied && result.style_params ? styleDiff(result.style_params) : []
  const rejected = rejectionList(result.steps)
  const requestContext = Object.hasOwn(result, '_request_context')
    ? result._request_context : result.context
  const goal = GOAL_LABELS[requestContext?.goal_mode || result.goal_mode] || '未记录'
  const protectedCount = contextSignature(requestContext)
    ? new Set(requestContext.locked_fields).size : null
  const protection = result.subject_protection
  const hasProtection = protection && normalizeSubjectMode(protection.subject_mode) === protection.subject_mode
    && typeof protection.enabled === 'boolean'
    && ['color_heuristic', 'localized_regions', 'manual_regions'].includes(protection.method)
  const localized = hasProtection && protection.method !== 'color_heuristic'
  const subjectMode = hasProtection ? protection.subject_mode : requestContext?.subject_mode
  const subjectLabel = subjectMode === undefined ? '未记录'
    : SUBJECT_MODE_LABELS[normalizeSubjectMode(subjectMode)]
  const suspectedRatio = hasProtection && Number.isFinite(protection.suspected_skin_ratio)
    && protection.suspected_skin_ratio >= 0 && protection.suspected_skin_ratio <= 1
    ? `${(protection.suspected_skin_ratio * 100).toFixed(1)}%` : null
  const sampleId = result._sample_id ?? result.main_sample_id
  const sampleName = result._sample_name || (sampleId ? '样张名称未记录' : '未记录')
  const recordedTime = result._applied_at || result.created_at
  const timestamp = recordedTime ? new Date(recordedTime) : null
  const validTime = timestamp && Number.isFinite(timestamp.getTime())
  const headline = applied ? gradeHeadline(result) : gradeHeadline(result).replace('已应用', '已完成')

  return (
    <section className="auto-report" tabIndex={-1}>
      <header className="auto-report-context">
        <strong>{historical ? '此前结果' : applied ? '当前已应用' : '本次结果 · 应用状态未记录'}</strong>
        <dl className="auto-summary">
          <dt>来源照片</dt>
          <dd title={sampleId || undefined}>{sampleName}</dd>
          <dt>当次目标</dt>
          <dd>{goal}</dd>
          <dt>当次照片内容</dt>
          <dd>{subjectLabel}{subjectMode === 'portrait' || subjectMode === 'non_portrait'
            ? protection?.source === 'auto' ? '（自动识别）' : '（人工确认）' : ''}</dd>
          <dt>人物颜色保护</dt>
          <dd>{hasProtection ? protection.enabled ? localized ? '已启用 · 已定位区域' : '已启用 · 疑似肤色颜色' : '未启用' : '执行情况未记录'}</dd>
          {suspectedRatio && <><dt>{localized ? '可测皮肤区域占比' : '疑似肤色颜色占比'}</dt><dd>{suspectedRatio}</dd></>}
          <dt>已保护</dt>
          <dd>{protectedCount === null ? '未记录' : `${protectedCount} 项参数`}</dd>
          <dt>{result._applied_at ? '应用时间' : '报告时间'}</dt>
          <dd>
            {validTime ? <time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString('zh-CN')}</time> : '未记录'}
          </dd>
        </dl>
        {hasProtection && <p className="workspace-note">{localized
          ? protection.enabled ? '肤色质量检查使用固定皮肤区域，暖色背景不参与。自动框为估计区域，可人工修正；此检查不提供局部调色。'
            : '本次没有足够的可测皮肤区域，未启用肤色保护；可查看人物识别结果或人工框选。'
          : '这份旧报告的疑似肤色只依据颜色范围，当时没有人物检测或分割。'}</p>}
      </header>
      {historical && (
        <p className="workspace-note">以下为当次报告。参数、主样张或创作上下文已变化，或当次上下文未记录。</p>
      )}
      {result.degraded && !result.goal_status && (
        <div className="auto-warn" role="status">
          <span aria-hidden="true">⚠</span>
          <span>未能完全达标,已采用保守调整(仅修正曝光与白平衡)</span>
        </div>
      )}

      <div className="auto-headline">{headline}</div>
      {result.goal_status && (
        <p className="workspace-note">
          目标状态：
          {
            {
              met: '已满足本次可测目标',
              partially_met: '目标部分完成',
              unchanged: '保留原参数',
              not_evaluated: '未评价校正目标',
            }[result.goal_status]
          }{' '}
          · 执行：
          {{ model: '模型调整', rules_only: '规则调整', failed: '未能完成', skipped: '已跳过' }[
            result.execution_status
          ] || result.execution_status}
        </p>
      )}
      {result.blocked_reasons?.length > 0 && (
        <p className="auto-warn">{result.blocked_reasons.join('；')}</p>
      )}

      <dl className="auto-summary">
        <dt>主要变化</dt>
        <dd>
          {changes.length > 0 ? (
            changes.slice(0, 3).map((c) => (
              <span key={c.key} className="chip delta">
                {c.text}
              </span>
            ))
          ) : (
            <span className="text-muted">无</span>
          )}
        </dd>
      </dl>

      {changes.length > 3 && (
        <details className="auto-details">
          <summary>其余 {changes.length - 3} 项参数变化</summary>
          <div>
            {changes.slice(3).map((c) => <span key={c.key} className="chip delta">{c.text}</span>)}
          </div>
        </details>
      )}
      {styleApplied.length > 0 && (
        <details className="auto-details">
          <summary>风格贡献 · {styleApplied.length} 项调整已计入候选</summary>
          <div>
            {styleApplied.map((c) => <span key={c.key} className="chip delta chip-style">{c.text}</span>)}
          </div>
        </details>
      )}
      {styleBlocked.length > 0 && (
        <details className="auto-details auto-style-blocked">
          <summary>风格被拦下 · {styleBlocked.length} 项提议未应用</summary>
          <div className="auto-small">模型理解为以下调整，但未通过安全校验，没有计入候选：</div>
          <div>
            {styleBlocked.map((c) => <span key={c.key} className="chip chip-blocked">{c.text}</span>)}
          </div>
          {result.style_rejections?.length > 0 && (
            <div className="auto-small">原因：{result.style_rejections.join('；')}</div>
          )}
        </details>
      )}
      {result.observations?.length > 0 && (
        <details className="auto-details">
          <summary>画面观察 · {result.observations.length} 项</summary>
          <div className="auto-evidence">
            {result.observations.map((item, index) => <div key={item.code || index}>· {item.evidence || item}</div>)}
          </div>
        </details>
      )}
      {result.issues?.length > 0 && (
        <details className="auto-details">
          <summary>与当次目标冲突 · {result.issues.length} 项</summary>
          <div className="auto-evidence">
            {result.issues.map((item, index) => <div key={item.code || index}>· {item.evidence}</div>)}
          </div>
        </details>
      )}
      {result.steps?.length > 0 && (
        <details className="auto-details">
          <summary>完整分析过程({result.steps.length} 步)</summary>
          <ol className="auto-steps">
            {result.steps.map((s, i) => (
              <li key={i}>
                <span className={s.applied ? 'auto-ok' : 'auto-no'}>{s.applied ? '✓' : '×'}</span>
                <div>
                  <div>
                    {s.stage === 'style' ? '风格化' : `第 ${s.round} 轮`}
                    {s.diagnosis ? `:${s.diagnosis}` : ''}
                  </div>
                  {!s.applied && s.rejections?.length > 0 && (
                    <div className="text-muted auto-small">{s.rejections.join(';')}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}

      {rejected.length > 0 && (
        <details className="auto-details auto-rejected">
          <summary>有 {rejected.length} 项提议被安全规则拦下</summary>
          <ul className="auto-small">
            {rejected.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      )}

      {result.review ? (
        <details className="auto-details">
          <summary>视觉复核意见 · 主观评价</summary>
          <div className="auto-review"><p>{result.review}</p></div>
        </details>
      ) : (
        <div className="auto-review-skipped text-muted">
          {reviewSkipText(result.review_skip_reason)}
        </div>
      )}

      {beforeParams && onUndo && (
        <div className="auto-report-actions">
          <button type="button" className="btn" onClick={onUndo}>
            撤销
          </button>
        </div>
      )}
    </section>
  )
}
