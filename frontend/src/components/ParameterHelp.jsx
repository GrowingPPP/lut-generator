import { useId } from 'react'
import { PARAMETER_HELP, BEGINNER_GUIDE } from '../lib/parameterHelp.js'
import HelpPopover from './ui/HelpPopover.jsx'
import './ParameterHelp.css'

function HelpContent({ parameter, summaryId }) {
  const help = PARAMETER_HELP[parameter]
  if (!help) return null
  const choice = ['base_photo_style', 'external_lut_id', 'external_lut_mode', 'curve_points'].includes(parameter)
  const color = ['selective_hue_center', 'split_shadow_hue', 'split_mid_hue', 'split_highlight_hue'].includes(parameter)
  const decreaseLabel = parameter === 'curve_points' ? '下移控制点' : choice ? '如何选择' : color ? '颜色位置' : '减小 / 向左'
  const increaseLabel = parameter === 'curve_points' ? '上移控制点' : choice ? '如何使用' : color ? '选色参考' : '增大 / 向右'
  return <>
    <p className="parameter-help-summary" id={summaryId}>{help.summary}</p>
    <dl className="parameter-help-directions">
      <div><dt>{decreaseLabel}</dt><dd>{help.decrease}</dd></div>
      <div><dt>{increaseLabel}</dt><dd>{help.increase}</dd></div>
    </dl>
    <p className="parameter-help-try"><strong>可以试试</strong>{help.tryThis}</p>
    {help.note && <p className="parameter-help-note"><strong>使用提醒</strong>{help.note}</p>}
  </>
}

function ParameterPopover({ parameter, compact = false }) {
  const summaryId = useId()
  const help = PARAMETER_HELP[parameter]
  if (!help) return null
  return <HelpPopover title={`${help.title} · 使用说明`} describedBy={summaryId}
    trigger={<button type="button" className={compact ? 'parameter-help-button' : 'parameter-help-link'}
      aria-label={`查看${help.title}使用说明`}>
      {compact ? <span aria-hidden="true">?</span> : <><span className="parameter-help-symbol" aria-hidden="true">?</span>{help.title} · 使用说明</>}
    </button>}>
    <div className="parameter-help-content"><HelpContent parameter={parameter} summaryId={summaryId} /></div>
  </HelpPopover>
}

export function ParameterInfo({ parameter }) {
  return <ParameterPopover parameter={parameter} compact />
}

export default function ParameterHelp({ parameter }) {
  return <ParameterPopover parameter={parameter} />
}

export function BeginnerGuideHelp() {
  return <HelpPopover hoverable title="新手创作指南" className="beginner-guide-popover"
    trigger={<button type="button" className="beginner-guide-trigger" aria-label="查看新手创作指南">
      <span className="parameter-help-symbol" aria-hidden="true">?</span><span>新手指南</span>
    </button>}>
    <div className="beginner-guide-content">
      <p>每次只改一项，小幅调整，再看原图对比。没有唯一正确的效果，先决定你想让照片表达什么。</p>
      <ol>{BEGINNER_GUIDE.map(item => <li key={item.title}><strong>{item.title}</strong><p>{item.body}</p></li>)}</ol>
      <p className="parameter-help-note">点击参数旁的「？」可查看使用说明，不影响照片。想试大胆一点时，先保存命名版本；不喜欢就撤销，参数保护可保留你已经满意的数值。</p>
    </div>
  </HelpPopover>
}
