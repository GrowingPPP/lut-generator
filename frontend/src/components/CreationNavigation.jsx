import { CREATION_STEPS } from '../lib/creationFlow.js'
import Tooltip from './ui/Tooltip.jsx'

export default function CreationNavigation({ step, onNavigate, disabled, titleRef }) {
  const current = CREATION_STEPS.find(item => item.id === step)
  return <>
    <nav className="creation-steps" aria-label="创作步骤">
      {CREATION_STEPS.map((item, index) => <Tooltip key={item.id} content={item.description}><button type="button"
        className="creation-step" aria-current={step === item.id ? 'step' : undefined}
        disabled={disabled} onClick={() => onNavigate(item.id)}>
        <span className="creation-step-number" aria-hidden="true">{index + 1}</span>
        <span className="creation-step-copy"><strong>{item.title}</strong><small>{item.hint}</small></span>
      </button></Tooltip>)}
    </nav>
    <h1 className="creation-title-accessible" ref={titleRef} tabIndex={-1}>{current.heading}</h1>
  </>
}
