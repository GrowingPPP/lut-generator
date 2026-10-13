import ParameterControls from './ParameterControls.jsx'
import './ParameterPanel.css'

/** Presentation is shared by the workbench and viewer; edits remain in useWorkspace. */
export default function ParameterPanel({ allParameters = false, onPresentationChange, children, ...controls }) {
  return <section className="parameter-panel">
    <div className="parameter-panel-heading">
      <h2>{allParameters ? '全部调色参数' : '基础调整'}</h2>
      <button type="button" className="btn btn-ghost btn-sm" aria-pressed={allParameters}
        onClick={() => onPresentationChange?.(!allParameters)}>
        {allParameters ? '回到基础' : '全部参数'}
      </button>
    </div>
    <fieldset className="params param-groups" disabled={controls.disabled}>
      <ParameterControls {...controls} presentation={allParameters ? 'groups' : 'basic'} />
      {children}
    </fieldset>
  </section>
}
