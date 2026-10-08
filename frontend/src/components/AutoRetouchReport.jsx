import { diffParams, gradeHeadline, rejectionList } from '../lib/autoGrade.js'

/**
 * 自动修图的修改说明面板。
 *
 * 设计要点:
 *  - 降级警示必须显眼(role="status" 而非 alert —— 它不是错误,不该打断)
 *  - 「风格理解」单独一行:这是最可能出错的地方(模型把「日系清透」理解成「大幅提亮」),
 *    必须让用户能一眼核对
 *  - 被拒项默认折叠,但摘要行必须显示数量
 *  - 复检意见来自另一个模型调用、性质是主观判断,用左边框与确定性数字视觉区隔
 */
export default function AutoRetouchReport({ result, beforeParams, onUndo }) {
  if (!result) return null

  const changes = diffParams(beforeParams, result.params)
  const styleChanges = result.style_params
    ? diffParams({}, { ...emptyLike(result.style_params), ...result.style_params })
    : []
  const rejected = rejectionList(result.steps)

  return (
    <section className="auto-report" tabIndex={-1}>
      {result.degraded && (
        <div className="auto-warn" role="status">
          <span aria-hidden="true">⚠</span>
          <span>未能完全达标,已采用保守调整(仅修正曝光与白平衡)</span>
        </div>
      )}

      <div className="auto-headline">{gradeHeadline(result)}</div>

      <dl className="auto-summary">
        <dt>本次调整</dt>
        <dd>
          {changes.length > 0
            ? changes.map((c) => <span key={c.key} className="chip delta">{c.text}</span>)
            : <span className="text-muted">无</span>}
        </dd>

        {styleChanges.length > 0 && (
          <>
            <dt>风格理解</dt>
            <dd>
              {styleChanges.map((c) => (
                <span key={c.key} className="chip delta chip-style">{c.text}</span>
              ))}
            </dd>
          </>
        )}

        {result.issues?.length > 0 && (
          <>
            <dt>诊断</dt>
            <dd className="auto-evidence">
              {result.issues.map((i) => <div key={i.code}>· {i.evidence}</div>)}
            </dd>
          </>
        )}
      </dl>

      {result.steps?.length > 0 && (
        <details className="auto-details">
          <summary>完整分析过程({result.steps.length} 步)</summary>
          <ol className="auto-steps">
            {result.steps.map((s, i) => (
              <li key={i}>
                <span className={s.applied ? 'auto-ok' : 'auto-no'}>{s.applied ? '✓' : '×'}</span>
                <div>
                  <div>{s.stage === 'style' ? '风格化' : `第 ${s.round} 轮`}{s.diagnosis ? `:${s.diagnosis}` : ''}</div>
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
            {rejected.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </details>
      )}

      {result.review ? (
        <div className="auto-review">
          <span className="auto-review-label">视觉复核</span>
          <p>{result.review}</p>
        </div>
      ) : (
        <div className="auto-review-skipped text-muted">已关闭视觉复核,本次仅依据客观数据调整。</div>
      )}

      <div className="auto-report-actions">
        <button type="button" className="btn" onClick={onUndo}>撤销</button>
      </div>
    </section>
  )
}

/** 风格参数是增量,展示时需要一个全零基准才能算出「变化」。 */
function emptyLike(delta) {
  const out = {}
  for (const [k, v] of Object.entries(delta)) {
    out[k] = Array.isArray(v) ? v.map(() => 0) : 0
  }
  return out
}
