import { useEffect, useRef, useState } from 'react'
import { PARAMETER_GROUP_HELP } from '../lib/parameterHelp.js'
import { ParameterInfo } from './ParameterHelp.jsx'
import RangeField, { NumberField } from './ui/RangeField.jsx'
import ActionMenu from './ui/ActionMenu.jsx'
import ActionIcon from './ui/ActionIcon.jsx'
import ProtectionButton from './ui/ProtectionButton.jsx'
import Tooltip from './ui/Tooltip.jsx'
import { useDialogs } from './ui/Dialog.jsx'
import {
  PARAM_GROUPS, RGB_GROUPS, RGB_CHANNELS, defaultGroupOpen, groupSummary, parameterLabel,
} from '../lib/parameterControls.js'

export default function ParameterControls({
  params, lockedFields = [], disabled = false, groupOpen, onGroupOpen,
  gesture = {}, onUpdateParam, onUpdateChannel, onToggleLock, onReset, onSetLocks,
  showFooter = true, contextKey, presentation = 'groups',
}) {
  const [localOpen, setLocalOpen] = useState(defaultGroupOpen)
  const [confirming, setConfirming] = useState(false)
  const { confirm } = useDialogs()
  const mounted = useRef(false)
  const pendingReset = useRef(false)
  const current = useRef(null)
  const signature = JSON.stringify([contextKey, params, [...lockedFields].sort(), disabled])
  const revision = current.current && current.current.signature === signature ? current.current.revision : (current.current?.revision ?? 0) + 1
  current.current = { params, lockedFields, disabled, onReset, onSetLocks, signature, revision }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const open = groupOpen ?? localOpen
  const setOpen = onGroupOpen ?? setLocalOpen
  const locked = (key) => lockedFields.includes(key)
  const basic = presentation === 'basic'
  const basicKeys = ['exposure', 'temp', 'contrast', 'saturation']
  const groups = basic ? [{ id: 'essentials', label: '基础调整', sliders: basicKeys.map(key => PARAM_GROUPS.flatMap(group => group.sliders).find(slider => slider.key === key)) }] : PARAM_GROUPS
  const parameterKeys = Object.keys(params)
  const protectedCount = parameterKeys.filter(locked).length
  const blocked = disabled || confirming
  const setAllLocks = protect => {
    if (!mounted.current || current.current.disabled || pendingReset.current) return
    current.current.onSetLocks(protect ? Object.keys(current.current.params) : [])
  }
  const requestReset = async () => {
    if (!mounted.current || current.current.disabled || pendingReset.current) return
    const snapshot = current.current
    const fields = Object.keys(snapshot.params).filter(key => !['base_photo_style', 'tone_map'].includes(key))
    const retainedCount = fields.filter(key => snapshot.lockedFields.includes(key)).length
    pendingReset.current = true
    setConfirming(true)
    try {
      const allowed = await confirm({
        title: '复位未保护调色项？',
        description: `将复位未保护的调色参数、自由曲线和外部 LUT。保留 ${retainedCount} 项受保护的调色参数，并保留输入基准与显示映射。此操作可以撤销。`,
        confirmLabel: '复位未保护项',
        cancelLabel: '取消',
        destructive: true,
      })
      if (allowed && mounted.current && !current.current.disabled && current.current.revision === snapshot.revision) {
        current.current.onReset(fields)
      }
    } finally {
      pendingReset.current = false
      if (mounted.current) setConfirming(false)
    }
  }
  const lockButton = (key) => (
    <ProtectionButton label={parameterLabel(key)} locked={locked(key)} disabled={blocked} compact={!basic || !locked(key)}
      onClick={() => onToggleLock([key])} />
  )

  return <>
    {showFooter && <div className="parameter-management">
      <div className="parameter-management-copy" title="保护同时限制手动和 AI 修改">
        <span className="parameter-management-status">已保护 {protectedCount} / {parameterKeys.length} 项</span>
        <span className="parameter-management-summary">保护同时限制手动和 AI 修改</span>
      </div>
      <ActionMenu label="参数管理" disabled={blocked}
        trigger={<button type="button" className="btn btn-ghost btn-sm" disabled={blocked} aria-label="参数管理">
          <ActionIcon name="more" />管理
        </button>}
        items={[
          { id: 'protect-all', label: '保护全部参数', disabled: protectedCount === parameterKeys.length, onSelect: () => setAllLocks(true) },
          { id: 'unlock-all', label: '解除全部保护', disabled: !lockedFields.length, onSelect: () => setAllLocks(false) },
          { id: 'reset-unprotected', label: '复位未保护调色项…', description: '含自由曲线和外部 LUT', separator: true, destructive: true, onSelect: requestReset },
        ]} />
    </div>}
    {groups.map((group) => {
      const fields = group.id === 'rgb'
        ? RGB_GROUPS.map((rgb) => rgb.key)
        : group.sliders.map((slider) => slider.key)
      const protectedCount = fields.filter(locked).length
      return <section key={group.id} className={`param-group ${basic ? "param-group-essential" : ""}`}>
        <div className="param-group-header" hidden={basic}>
          <button
            type="button"
            className="param-group-head"
            aria-expanded={open[group.id]}
            disabled={blocked}
            onClick={() => setOpen({ ...open, [group.id]: !open[group.id] })}
          >
            <span className="param-group-arrow">{open[group.id] ? '▾' : '▸'}</span>
            <span className="param-group-label">{group.label}</span>
            <span className="param-group-hint">
              {groupSummary(group, params)}{protectedCount ? ` · ${protectedCount} 项已保护` : ''}
            </span>
          </button>
          <ProtectionButton label={`${group.label}参数组`} locked={fields.every(locked)}
            mixed={protectedCount > 0 && protectedCount < fields.length} disabled={blocked} onClick={() => onToggleLock(fields)} />
          <Tooltip content={`复位${group.label}中的未保护项；已保护项会保留。`}>
            <button type="button" className="btn btn-ghost btn-sm group-reset" disabled={blocked}
              aria-label={`复位${group.label}未保护项`} onClick={() => onReset(fields, group)}>
              <ActionIcon name="reset" />
            </button>
          </Tooltip>
        </div>
        {(basic || open[group.id]) && <div className="controls">
          {!basic && <p className="parameter-group-description">{PARAMETER_GROUP_HELP[group.id].summary} <strong>{PARAMETER_GROUP_HELP[group.id].startWith}</strong></p>}
          {group.id === 'rgb'
            ? RGB_GROUPS.map((rgb) => <div key={rgb.key} className="rgb-group">
              <div className="rgb-group-title">
                <span className="parameter-name rgb-group-label">{rgb.label}<ParameterInfo parameter={rgb.key} /></span>
                {lockButton(rgb.key)}
              </div>
              {RGB_CHANNELS.map((channel, index) => <div key={channel} className="slider rgb-slider">
                <span>{channel}</span>
                <RangeField
                  aria-label={`${rgb.label} ${channel}`}
                  min={rgb.min}
                  max={rgb.max}
                  step={rgb.step}
                  value={params[rgb.key][index]}
                  disabled={blocked || locked(rgb.key)}
                  {...gesture}
                  onChange={(event) => onUpdateChannel(rgb.key, index, Number(event.target.value))}
                />
                <NumberField aria-label={`${rgb.label} ${channel} 数值`} min={rgb.min} max={rgb.max} step={rgb.step}
                  value={params[rgb.key][index]} disabled={blocked || locked(rgb.key)} {...gesture}
                  onChange={event => onUpdateChannel(rgb.key, index, Number(event.target.value))} />
              </div>)}
            </div>)
            : group.sliders.map((slider) => <div key={slider.key} className="parameter-control">
              <div className={`slider ${locked(slider.key) ? 'protected' : ''}`}>
              <span className="parameter-name">{slider.label}<ParameterInfo parameter={slider.key} /></span>
              <RangeField
                aria-label={slider.label}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                value={params[slider.key]}
                disabled={blocked || locked(slider.key)}
                {...gesture}
                onChange={(event) => onUpdateParam(slider.key, Number(event.target.value))}
              />
              <NumberField aria-label={`${slider.label} 数值`} min={slider.min} max={slider.max} step={slider.step}
                value={params[slider.key]} unit={slider.unit} disabled={blocked || locked(slider.key)} {...gesture}
                onChange={event => onUpdateParam(slider.key, Number(event.target.value))} />
              {lockButton(slider.key)}
              </div>
            </div>)}
        </div>}
      </section>
    })}
  </>
}
