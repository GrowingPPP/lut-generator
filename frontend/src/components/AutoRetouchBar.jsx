import { useState } from 'react'
import { autoGrade } from '../lib/api.js'
import { summarizeSteps } from '../lib/autoGrade.js'

/**
 * AI 自动修图:一键触发 + 进度展示。
 *
 * 设计要点(见 docs/specs/ui-design.md):
 *  - 未上传真实照片时禁用 —— 对内置合成图做分析没有意义
 *  - 提交时固定一份参数快照,避免报告与正在编辑的参数不一致
 *  - 视觉复核的数据用途直接显示在界面上
 */
export default function AutoRetouchBar({
  file, params, onResult, onBeforeRun, hasRealPhoto, running, setRunning, setStatus,
}) {
  const [style, setStyle] = useState('')
  const [useVision, setUseVision] = useState(true)
  const [steps, setSteps] = useState([])

  const canRun = hasRealPhoto && !!file && !running

  const run = async () => {
    if (!canRun) return
    if (onBeforeRun) onBeforeRun(params)      // 保存快照供撤销
    setRunning(true)
    setStatus('')
    // 先摆出四步骨架,再随结果填充 —— 固定顺序让用户能预期
    setSteps(summarizeSteps([], { hasStyle: !!style.trim(), hasVision: useVision }))
    try {
      const result = await autoGrade({ file, params, style, useVision })
      setSteps(summarizeSteps(result.steps, {
        hasStyle: !!style.trim(),
        hasVision: useVision && !!result.review,
      }))
      onResult(result)
      setStatus(result.degraded ? '已采用保守调整(未能完全达标)' : '已应用自动修图,可继续微调')
    } catch (e) {
      setStatus(e.message)
      setSteps([])
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="auto-bar">
        <span className="auto-bar-icon" aria-hidden="true">✦</span>
        <input
          className="auto-style-input"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canRun) run() }}
          placeholder="风格(可选):日系清透一点"
          maxLength={200}
          disabled={running}
          aria-label="风格描述"
        />
        <button
          type="button"
          className="btn-primary auto-go"
          onClick={run}
          disabled={!canRun}
          title={hasRealPhoto ? '' : '请先上传样张'}
        >
          {running ? '修图中…' : 'AI 自动修图'}
        </button>
        <label
          className="auto-vision"
          title="开启后会把照片与修图结果发送给模型做主观复检,更准但更慢。关闭后只根据客观数据调整。"
        >
          <input
            type="checkbox"
            checked={useVision}
            onChange={(e) => setUseVision(e.target.checked)}
            disabled={running}
          />
          <span>视觉复核</span>
        </label>
      </div>
      <p className="text-muted">开启视觉复核会将照片与调色预览发送给模型；关闭后只发送统计数据。上传的照片不会保存在本系统中。</p>

      {running && steps.length > 0 && (
        <div className="auto-progress" aria-live="polite">
          {/* 服务端是同步的,没有中间进度可报 —— 与其假装有进度(之前把第二步
              一直标成「进行中」),不如坦白说「正在分析,还不知道到哪一步」。
              四步清单仍有信息量:它告诉用户**将要**发生什么。 */}
          <div className="auto-progress-head">
            <span className="auto-spinner" aria-hidden="true">◐</span>
            <span>正在分析照片…</span>
          </div>
          <ol className="auto-progress-plan">
            {steps.map((s) => (
              <li key={s.key} className={`auto-step ${s.state === 'skipped' ? 'skipped' : 'pending'}`}>
                <span className="auto-step-mark">{s.state === 'skipped' ? '–' : '·'}</span>
                <span className="auto-step-title">{s.title}</span>
                <span className="auto-step-detail">
                  {s.state === 'skipped' ? s.detail : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  )
}
