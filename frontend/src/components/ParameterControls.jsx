import { useState } from 'react'
import {
  PARAM_GROUPS, RGB_GROUPS, RGB_CHANNELS, defaultGroupOpen, groupSummary, parameterLabel,
} from '../lib/parameterControls.js'

export default function ParameterControls({
  params, lockedFields = [], disabled = false, groupOpen, onGroupOpen,
  gesture = {}, onUpdateParam, onUpdateChannel, onToggleLock, onReset, onSetLocks,
  showFooter = true,
}) {
  const [localOpen, setLocalOpen] = useState(defaultGroupOpen)
  const open = groupOpen ?? localOpen
  const setOpen = onGroupOpen ?? setLocalOpen
  const locked = (key) => lockedFields.includes(key)
  const lockButton = (key) => (
    <button
      type="button"
      className={`parameter-lock ${locked(key) ? 'locked' : ''}`}
      aria-label={`${locked(key) ? '解锁' : '保护'}${parameterLabel(key)}`}
      title={locked(key) ? '解除参数保护' : '保护参数'}
      disabled={disabled}
      onClick={() => onToggleLock([key])}
    >
      {locked(key) ? '已保护' : '保护'}
    </button>
  )

  return <>
    {PARAM_GROUPS.map((group) => {
      const fields = group.id === 'rgb'
        ? RGB_GROUPS.map((rgb) => rgb.key)
        : group.sliders.map((slider) => slider.key)
      const protectedCount = fields.filter(locked).length
      return <section key={group.id} className="param-group">
        <div className="param-group-header">
          <button
            type="button"
            className="param-group-head"
            aria-expanded={open[group.id]}
            disabled={disabled}
            onClick={() => setOpen({ ...open, [group.id]: !open[group.id] })}
          >
            <span className="param-group-arrow">{open[group.id] ? '▾' : '▸'}</span>
            <span className="param-group-label">{group.label}</span>
            <span className="param-group-hint">
              {groupSummary(group, params)}{protectedCount ? ` · ${protectedCount} 项已保护` : ''}
            </span>
          </button>
          <button type="button" className="parameter-lock" disabled={disabled} onClick={() => onToggleLock(fields)}>
            {fields.every(locked) ? '解锁组' : '保护组'}
          </button>
          <button type="button" className="group-reset" disabled={disabled} onClick={() => onReset(fields, group)}>
            复位
          </button>
        </div>
        {open[group.id] && <div className="controls">
          {group.id === 'rgb'
            ? RGB_GROUPS.map((rgb) => <div key={rgb.key} className="rgb-group">
              <div className="rgb-group-title">
                <span className="rgb-group-label">{rgb.label}</span>
                {lockButton(rgb.key)}
              </div>
              {RGB_CHANNELS.map((channel, index) => <label key={channel} className="slider rgb-slider">
                <span>{channel}</span>
                <input
                  type="range"
                  aria-label={`${rgb.label} ${channel}`}
                  min={rgb.min}
                  max={rgb.max}
                  step={rgb.step}
                  value={params[rgb.key][index]}
                  disabled={disabled || locked(rgb.key)}
                  {...gesture}
                  onChange={(event) => onUpdateChannel(rgb.key, index, Number(event.target.value))}
                />
                <em>{params[rgb.key][index].toFixed(2)}</em>
              </label>)}
            </div>)
            : group.sliders.map((slider) => <div key={slider.key} className={`slider ${locked(slider.key) ? 'protected' : ''}`}>
              <span>{slider.label}</span>
              <input
                type="range"
                aria-label={slider.label}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={params[slider.key]}
                disabled={disabled || locked(slider.key)}
                {...gesture}
                onChange={(event) => onUpdateParam(slider.key, Number(event.target.value))}
              />
              <em>{Number(params[slider.key]).toFixed(2)}{slider.unit}</em>
              {lockButton(slider.key)}
            </div>)}
        </div>}
      </section>
    })}
    {showFooter && <div className="all-parameter-actions">
      <button type="button" className="btn" disabled={disabled} onClick={() => onSetLocks(Object.keys(params))}>
        保护全部参数
      </button>
      <button type="button" className="btn" disabled={disabled} onClick={() => onSetLocks([])}>
        解除全部保护
      </button>
      <button
        type="button"
        className="btn"
        disabled={disabled}
        onClick={() => onReset(Object.keys(params).filter((key) => !['base_photo_style', 'tone_map'].includes(key)))}
      >
        复位全部未保护调色项
      </button>
    </div>}
  </>
}
