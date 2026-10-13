import ParameterControls from './ParameterControls.jsx'
import './ParameterPanel.css'

/** Presentation is shared by the workbench and viewer; edits remain in useWorkspace. */
export default function ParameterPanel({ allParameters = false, onPresentationChange, children, ...controls }) {
  return <section className="parameter-panel">
    <div className="parameter-presentation" role="group" aria-label="调色参数展示范围">
      <button type="button" aria-pressed={!allParameters} onClick={() => onPresentationChange?.(false)}>
        基础调整<span className="parameter-presentation-count">4 项</span>
      </button>
      <button type="button" aria-pressed={allParameters} onClick={() => onPresentationChange?.(true)}>
        全部参数
      </button>
    </div>
    <p className="parameter-presentation-note">{allParameters
      ? '按分组查看全部调整项，点击分组名称展开。'
      : '先从 4 项开始；高光、阴影、色彩与 RGB 等调整在「全部参数」。'}</p>
    <fieldset className="params param-groups" disabled={controls.disabled}>
      <ParameterControls {...controls} presentation={allParameters ? 'groups' : 'basic'} />
      {children}
    </fieldset>
  </section>
}
