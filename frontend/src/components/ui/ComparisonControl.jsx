import { useId } from 'react'
import RangeField from './RangeField.jsx'
import './ComparisonControl.css'

export default function ComparisonControl({ value, onChange, before = '原图', after = '当前效果', overlay = false }) {
  const id = useId()
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return <div className={`comparison-control ${overlay ? 'is-overlay' : ''}`}>
    {!overlay && <label htmlFor={id}>{before} / {after}</label>}
    <RangeField id={id} value={percent} min={0} max={100} step={1}
      aria-label={`${before}与${after}对比分界`}
      aria-valuetext={`${before} ${percent}%，${after} ${100 - percent}%`}
      onChange={event => onChange(Number(event.target.value) / 100)} />
  </div>
}
