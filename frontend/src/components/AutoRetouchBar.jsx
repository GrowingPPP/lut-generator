import { useId } from 'react'
import CheckboxField from './ui/CheckboxField.jsx'
import useAutoRetouchController from '../hooks/useAutoRetouchController.js'

export default function AutoRetouchBar(props) {
  return props.controller
    ? <ControlledAutoRetouchBar {...props} />
    : <UncontrolledAutoRetouchBar {...props} />
}

function UncontrolledAutoRetouchBar(props) {
  const controller = useAutoRetouchController(props)
  return <ControlledAutoRetouchBar {...props} controller={controller} />
}

export function ControlledAutoRetouchBar({ controller, context, running, disabled, hasRealPhoto, sampleName, showSample = true }) {
  const inputId = useId()
  const { style, setStyle, useVision, setUseVision, job, failedRequest, cancelling,
    preparing, continuable, recoveryMissing, canRun, canRetry, canContinue, run,
    cancel, steps, head } = controller
  return (
    <>
      <div className="auto-bar">
        <label className="auto-input-label" htmlFor={inputId}>风格与保留要求{context?.goal_mode === 'style_only' ? '（必填）' : '（可选）'}</label>
        <textarea id={inputId} className="auto-style-input" value={style} onChange={(e) => setStyle(e.target.value)} rows={3}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canRun) run() }}
          placeholder={context?.goal_mode === 'style_only' ? '例如：日系清透，降低饱和度，保留暖色高光。' : '例如：保留夕阳的暖色，改善暗部偏色。'}
          maxLength={200} disabled={running || disabled} aria-label="照片优化补充要求" />
      </div>
      <div className="auto-run-actions">
        <label className="auto-vision" title="开启后在调色前识别人和皮肤区域，并对修图结果复核；关闭后不向模型发送图片。已有区域仍可用于确定性检查。">
          <CheckboxField checked={useVision} onChange={(e) => setUseVision(e.target.checked)} disabled={running || disabled} />
          <span>图像分析与复核</span>
        </label>
        <p className="auto-privacy-note">{useVision ? '开启图像分析：将主样张缩小预览发送给模型，识别人和皮肤区域并复核效果。' : '图像分析已关闭：只发送统计数据；已有区域仍用于检查。'}本系统不保存上传原文件。</p>
        <button type="button" className="btn-primary auto-go" onClick={() => run()}
          disabled={!canRun} title={hasRealPhoto ? '' : '请先上传样张'}>
          {running ? '正在分析与调整…' : '分析并应用'}
        </button>
        {running && <button type="button" className="btn" onClick={cancel}
          disabled={(!preparing && !recoveryMissing && !job?.can_cancel) || cancelling} title={job?.progress?.stage === 'save' ? '保存已开始，不能取消' : ''}>
          {cancelling ? '正在取消…' : recoveryMissing ? '结束未确认提交' : job?.progress?.stage === 'save' ? '正在保存…' : '取消分析'}</button>}
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
      {(showSample || !hasRealPhoto) && <p className="workspace-note">AI 主样张：{sampleName || '尚未选择'}{hasRealPhoto ? '' : ' · 请确认输入并绑定原文件'}</p>}
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
