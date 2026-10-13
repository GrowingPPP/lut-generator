import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import * as Select from '@radix-ui/react-select'
import {
  decodeSelectValue, encodeSelectValue, initialSelectValue, selectedSelectOption,
  selectOptionsFromChildren,
} from '../lib/selectOptions.js'
import './SelectField.css'

const nativeStyle = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', clipPath: 'inset(50%)',
  whiteSpace: 'nowrap', border: 0, pointerEvents: 'none',
}

const SelectField = forwardRef(function SelectField({
  children, value, defaultValue, onChange, disabled = false, required = false,
  name, form, id, className = '', style, title, onInvalid, onKeyDown,
  onKeyUp, autoComplete, ...triggerProps
}, forwardedRef) {
  const generatedId = useId()
  const options = selectOptionsFromChildren(children)
  const [localValue, setLocalValue] = useState(() => initialSelectValue(options, defaultValue))
  const [open, setOpen] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [fieldsetDisabled, setFieldsetDisabled] = useState(false)
  const nativeRef = useRef(null)
  const triggerRef = useRef(null)
  const initialValue = useRef(localValue)
  const controlled = value !== undefined
  const selected = selectedSelectOption(options, controlled ? value : localValue)
  const currentValue = selected?.value ?? ''
  const blocked = disabled || fieldsetDisabled
  const errorId = `${generatedId}-error`
  const describedBy = [triggerProps['aria-describedby'], invalid ? errorId : null].filter(Boolean).join(' ') || undefined

  useEffect(() => {
    const native = nativeRef.current
    if (!native) return undefined
    const sync = () => setFieldsetDisabled(native.matches(':disabled'))
    sync()
    const fieldsets = []
    let ancestor = native.parentElement
    while (ancestor) {
      if (ancestor.tagName === 'FIELDSET') fieldsets.push(ancestor)
      ancestor = ancestor.parentElement
    }
    const observer = new MutationObserver(sync)
    fieldsets.forEach(fieldset => observer.observe(fieldset, { attributes: true, attributeFilter: ['disabled'] }))
    return () => observer.disconnect()
  }, [disabled])

  useEffect(() => { if (blocked) setOpen(false) }, [blocked])
  useEffect(() => {
    if (currentValue !== '') setInvalid(false)
  }, [currentValue])
  useEffect(() => {
    const native = nativeRef.current
    const associatedForm = native?.form
    if (!associatedForm) return undefined
    const reset = () => {
      if (!controlled) setLocalValue(initialValue.current)
      setInvalid(false)
      setOpen(false)
    }
    associatedForm.addEventListener('reset', reset)
    return () => associatedForm.removeEventListener('reset', reset)
  }, [form, controlled])

  function choose(encoded) {
    const next = decodeSelectValue(encoded)
    const native = nativeRef.current
    if (!native || native.matches(':disabled') || next === undefined ||
        !options.some(option => option.value === next && !option.disabled)) return
    native.value = next
    native.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function keyDown(event) {
    onKeyDown?.(event)
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    } else if (event.key !== 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopPropagation()
    }
  }

  return <span className={`select-field ${className}`.trim()} style={style}
    onChange={event => { if (event.target !== nativeRef.current) event.stopPropagation() }}>
    <Select.Root value={encodeSelectValue(currentValue)} onValueChange={choose}
      open={open} onOpenChange={setOpen} disabled={blocked}
      form={`${generatedId}-radix-internal`}>
      <Select.Trigger {...triggerProps} id={id} form={form} className="select-trigger"
        data-chroma-select-trigger="true" aria-required={required || undefined}
        aria-invalid={invalid || triggerProps['aria-invalid'] || undefined}
        aria-describedby={describedBy} title={title || selected?.label}
        onKeyDown={keyDown} onKeyUp={onKeyUp}
        ref={node => {
          triggerRef.current = node
          if (typeof forwardedRef === 'function') forwardedRef(node)
          else if (forwardedRef) forwardedRef.current = node
        }}>
        <span className="select-value"><Select.Value>{selected?.label || '\u00a0'}</Select.Value></span>
        <Select.Icon className="select-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" data-chroma-select-content="true"
          position="popper" sideOffset={6} collisionPadding={8} align="start"
          onEscapeKeyDown={event => {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}
          onKeyDown={event => event.stopPropagation()}>
          <Select.ScrollUpButton className="select-scroll-button" aria-label="向上滚动选项">⌃</Select.ScrollUpButton>
          <Select.Viewport className="select-viewport">
            {options.map((option, index) => <Select.Item className="select-option"
              key={`${option.value}:${index}`} value={encodeSelectValue(option.value)}
              disabled={option.disabled} textValue={option.label}
              aria-describedby={option.description ? `${generatedId}-option-${index}-description` : undefined}>
              <span className="select-option-text">
                <Select.ItemText>{option.label || '\u00a0'}</Select.ItemText>
                {option.description && <span className="select-option-description" id={`${generatedId}-option-${index}-description`}>{option.description}</span>}
              </span>
              <Select.ItemIndicator className="select-option-check" aria-hidden="true">✓</Select.ItemIndicator>
            </Select.Item>)}
          </Select.Viewport>
          <Select.ScrollDownButton className="select-scroll-button" aria-label="向下滚动选项">⌄</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
    <select ref={nativeRef} className="select-native" style={nativeStyle}
      value={currentValue} name={name} form={form} required={required} disabled={disabled}
      autoComplete={autoComplete} tabIndex={-1} aria-hidden="true"
      onChange={event => {
        if (!controlled) setLocalValue(event.target.value)
        setInvalid(false)
        onChange?.(event)
      }}
      onInvalid={event => {
        onInvalid?.(event)
        event.preventDefault()
        setInvalid(true)
        const native = event.currentTarget
        const firstInvalid = native.form
          ? Array.from(native.form.elements).find(control => control.willValidate && !control.validity.valid)
          : native
        if (firstInvalid === native) triggerRef.current?.focus()
      }}>
      {children}
    </select>
    {invalid && <span className="select-validation" id={errorId} role="alert">请选择一项</span>}
  </span>
})

export default SelectField
