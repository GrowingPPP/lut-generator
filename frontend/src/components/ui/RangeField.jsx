import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import * as Slider from '@radix-ui/react-slider'
import { createRangeGesture, formatRangeNumber, parseRangeNumber, rangeValueEvent, RANGE_KEYS } from '../../lib/rangeField.js'
import './RangeField.css'

const RangeField = forwardRef(function RangeField({
  value, min = 0, max = 100, step = 1, disabled = false, id, name, form,
  className = '', onChange, onPointerDown, onPointerUp, onPointerCancel,
  onBlur, onKeyDown, onKeyUp, onLostPointerCapture, style, ...thumbProps
}, forwardedRef) {
  const generatedId = useId()
  const nativeRef = useRef(null)
  const thumbRef = useRef(null)
  const callbacks = useRef({})
  callbacks.current = { onChange, onPointerDown, onPointerUp, onPointerCancel, onBlur, onKeyDown, onKeyUp }
  const transaction = useRef(null)
  if (!transaction.current) transaction.current = createRangeGesture(() => callbacks.current, Number(value), { id, name })
  const gesture = transaction.current
  gesture.sync(Number(value))
  const [inheritedDisabled, setInheritedDisabled] = useState(false)
  const blocked = disabled || inheritedDisabled
  useEffect(() => {
    const native = nativeRef.current
    if (!native) return undefined
    const sync = () => setInheritedDisabled(native.matches(':disabled'))
    sync()
    const observer = new MutationObserver(sync)
    let ancestor = native.parentElement
    while (ancestor) {
      if (ancestor.tagName === 'FIELDSET') observer.observe(ancestor, { attributes: true, attributeFilter: ['disabled'] })
      ancestor = ancestor.parentElement
    }
    return () => observer.disconnect()
  }, [disabled])
  useEffect(() => { if (blocked) gesture.finish('disabled') }, [blocked, gesture])
  useEffect(() => () => gesture.finish('unmount'), [gesture])
  const isBlocked = () => disabled || nativeRef.current?.matches(':disabled')
  return <>
    <Slider.Root className={`range-field ${className}`.trim()} style={style}
      value={[Number(value)]} min={Number(min)} max={Number(max)} step={Number(step)} disabled={blocked}
      form={`${generatedId}-slider-internal`}
      onValueChange={values => { if (!isBlocked()) gesture.update(values[0]) }}
      onPointerDown={event => {
        if (isBlocked() || event.button !== 0) { event.preventDefault(); return }
        thumbRef.current?.focus({ preventScroll: true })
        gesture.begin('pointer', event)
      }}
      onPointerUp={event => gesture.finish('pointer', event)}
      onPointerCancel={event => gesture.finish('cancel', event)}
      onLostPointerCapture={event => { gesture.finish('capture', event); onLostPointerCapture?.(event) }}
      onBlur={event => gesture.finish('blur', event)}
      onKeyDown={event => {
        if (RANGE_KEYS.includes(event.key)) {
          event.stopPropagation()
          if (isBlocked()) event.preventDefault()
          else gesture.begin('key', event)
        } else onKeyDown?.(event)
      }}
      onKeyUp={event => { if (RANGE_KEYS.includes(event.key)) gesture.finish('key', event); else onKeyUp?.(event) }}>
      <Slider.Track className="range-track"><Slider.Range className="range-fill" /></Slider.Track>
      <Slider.Thumb asChild {...thumbProps} id={id} ref={node => {
        thumbRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}><button type="button" className="range-thumb" disabled={blocked} /></Slider.Thumb>
    </Slider.Root>
    <input ref={nativeRef} type="hidden" name={name} form={form} disabled={disabled} value={value} />
  </>
})

export const NumberField = forwardRef(function NumberField({
  value, min = 0, max = 100, step = 1, disabled = false, unit = '', className = '',
  onChange, onPointerDown, onPointerUp, onPointerCancel, onBlur, onKeyDown, onKeyUp,
  ...inputProps
}, forwardedRef) {
  const [draft, setDraft] = useState(() => formatRangeNumber(value, step))
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const errorId = useId()
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    if (!editing || disabled) setDraft(formatRangeNumber(value, step))
    if (disabled) { setEditing(false); setError('') }
  }, [value, step, disabled, editing])
  function commit(event, reason) {
    if (disabled || inputRef.current?.matches(':disabled')) {
      setDraft(formatRangeNumber(latest.current, step)); setError(''); return
    }
    const parsed = parseRangeNumber(draft, { min, max, step }, latest.current)
    if (!parsed.valid) {
      setError(parsed.reason === 'range' ? `请输入 ${min} 至 ${max} 之间的数字`
        : parsed.reason === 'step' ? `请按 ${step} 的步长输入` : '请输入有效数字')
      if (reason === 'blur') setDraft(formatRangeNumber(latest.current, step))
      return
    }
    setDraft(formatRangeNumber(parsed.value, step)); setError('')
    if (parsed.value === Number(latest.current)) return
    const changed = rangeValueEvent(parsed.value, event, { id: inputProps.id, name: inputProps.name })
    onPointerDown?.(changed)
    onChange?.(changed)
    if (reason === 'blur') (onBlur || onPointerUp)?.(changed)
    else (onPointerUp || onBlur)?.(changed)
  }
  return <span className={`number-field ${className}`.trim()}>
    <input {...inputProps} type="number" className="number-input" min={min} max={max} step={step}
      value={draft} disabled={disabled} aria-invalid={Boolean(error) || undefined}
      aria-describedby={[inputProps['aria-describedby'], error ? errorId : null].filter(Boolean).join(' ') || undefined}
      data-chroma-escape-cancel={editing ? 'true' : undefined}
      ref={node => {
        inputRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      }}
      onFocus={() => setEditing(true)} onChange={event => { setDraft(event.target.value); setError('') }}
      onBlur={event => { commit(event, 'blur'); setEditing(false) }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(event, 'enter') }
        else if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setDraft(formatRangeNumber(latest.current, step)); setError('')
        } else if (RANGE_KEYS.includes(event.key)) event.stopPropagation()
      }} />
    {unit && <span className="number-unit" aria-hidden="true">{unit}</span>}
    {error && <span className="number-error" id={errorId} role="alert">{error}</span>}
  </span>
})

export default RangeField
