import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import './CheckboxField.css'

const CheckboxField = forwardRef(function CheckboxField({
  checked, defaultChecked = false, onChange, disabled = false, className = '',
  onKeyDown, onInvalid, ...props
}, forwardedRef) {
  const ref = useRef(null)
  const [local, setLocal] = useState(defaultChecked)
  const [invalid, setInvalid] = useState(false)
  const errorId = `${useId()}-checkbox-error`
  const current = checked === undefined ? local : checked
  useEffect(() => { if (current || disabled) setInvalid(false) }, [current, disabled])
  const describedBy = [props['aria-describedby'], invalid ? errorId : ''].filter(Boolean).join(' ') || undefined
  return <span className="checkbox-control" onInvalid={event => {
    onInvalid?.(event)
    event.preventDefault()
    setInvalid(true)
    // Radix keeps the real checkbox beside its button; validation should focus the visible control.
    const native = event.target
    const firstInvalid = native.form && Array.from(native.form.elements)
      .find(control => control.willValidate && !control.validity.valid)
    if (!firstInvalid || firstInvalid === native) ref.current?.focus()
  }}><Checkbox.Root {...props} checked={Boolean(current)} disabled={disabled}
    className={`checkbox-field ${className}`.trim()}
    aria-invalid={invalid || props['aria-invalid'] || undefined}
    aria-describedby={describedBy}
    onKeyDown={event => {
      onKeyDown?.(event)
      if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
    }}
    onCheckedChange={next => {
      if (ref.current?.matches(':disabled')) return
      const selected = next === true
      setInvalid(false)
      if (checked === undefined) setLocal(selected)
      onChange?.({ type: 'change', target: { checked: selected, name: props.name, value: props.value ?? 'on' },
        currentTarget: { checked: selected, name: props.name, value: props.value ?? 'on' } })
    }}
    ref={node => {
      ref.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }}>
    <Checkbox.Indicator className="checkbox-indicator" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </Checkbox.Indicator>
  </Checkbox.Root>
    {invalid && <span id={errorId} className="checkbox-validation" role="alert">请勾选此项</span>}
  </span>
})

export default CheckboxField
