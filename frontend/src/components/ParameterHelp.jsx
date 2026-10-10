import { PARAMETER_HELP, BEGINNER_GUIDE } from '../lib/parameterHelp.js'
import './ParameterHelp.css'

function HelpContent({ parameter }) {
  const help = PARAMETER_HELP[parameter]
  if (!help) return null
  const choice = ['base_photo_style', 'external_lut_id', 'external_lut_mode', 'curve_points'].includes(parameter)
  const color = ['selective_hue_center', 'split_shadow_hue', 'split_mid_hue', 'split_highlight_hue'].includes(parameter)
  const decreaseLabel = parameter === 'curve_points' ? '下移控制点' : choice ? '如何选择' : color ? '颜色位置' : '减小 / 向左'
  const increaseLabel = parameter === 'curve_points' ? '上移控制点' : choice ? '如何使用' : color ? '选色参考' : '增大 / 向右'
  return <>
    <p className="parameter-help-summary">{help.summary}</p>
    <dl className="parameter-help-directions">
      <div><dt>{decreaseLabel}</dt><dd>{help.decrease}</dd></div>
      <div><dt>{increaseLabel}</dt><dd>{help.increase}</dd></div>
    </dl>
    <p className="parameter-help-try"><strong>可以试试</strong>{help.tryThis}</p>
    {help.note && <p className="parameter-help-note"><strong>使用提醒</strong>{help.note}</p>}
  </>
}

export function ParameterHelpButton({ parameter, open, onClick, controls }) {
  const help = PARAMETER_HELP[parameter]
  if (!help) return null
  return <button type="button" className="parameter-help-button" aria-expanded={open}
    aria-controls={open ? controls : undefined} aria-label={`${open ? '收起' : '查看'}${help.title}使用说明`}
    onClick={onClick}><span aria-hidden="true">?</span></button>
}

export function ParameterHelpPanel({ parameter, id }) {
  const help = PARAMETER_HELP[parameter]
  if (!help) return null
  return <div className="parameter-help-content" id={id} role="region" aria-label={`${help.title}使用说明`}>
    <HelpContent parameter={parameter} />
  </div>
}

export default function ParameterHelp({ parameter }) {
  const help = PARAMETER_HELP[parameter]
  if (!help) return null
  return <details className="parameter-help-disclosure">
    <summary><span className="parameter-help-symbol" aria-hidden="true">?</span>{help.title} · 使用说明</summary>
    <div className="parameter-help-content"><HelpContent parameter={parameter} /></div>
  </details>
}

export function BeginnerGuide() {
  return <details className="beginner-guide">
    <summary><span><strong>新手创作指南</strong><small>从看懂照片到形成自己的风格</small></span><span className="beginner-guide-arrow" aria-hidden="true">▾</span></summary>
    <div className="beginner-guide-content">
      <p>每次只改一项，小幅调整，再看原图对比。没有唯一正确的效果，先决定你想让照片表达什么。</p>
      <ol>{BEGINNER_GUIDE.map(item => <li key={item.title}><strong>{item.title}</strong><p>{item.body}</p></li>)}</ol>
      <p className="parameter-help-note">参数旁的「？」可以展开使用说明。想试大胆一点时，先保存命名版本；不喜欢就撤销，参数保护可保留你已经满意的数值。</p>
    </div>
  </details>
}
