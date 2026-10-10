export const RANGE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']

function decimals(value) {
  const [fraction, exponent = '0'] = String(value).toLowerCase().split('e')
  return Math.max(0, (fraction.split('.')[1]?.length || 0) - Number(exponent))
}

export function formatRangeNumber(value, step = 1) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const precision = Math.max(decimals(step), decimals(number))
  return precision > 8 ? String(number) : number.toFixed(precision)
}

export function parseRangeNumber(raw, { min = 0, max = 100, step = 1 } = {}, currentValue) {
  const text = String(raw).trim()
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return { valid: false, reason: 'number' }
  const value = Number(text)
  if (!Number.isFinite(value)) return { valid: false, reason: 'number' }
  if (value < Number(min) || value > Number(max)) return { valid: false, reason: 'range' }
  if (value === Number(currentValue)) return { valid: true, value }
  if (step !== 'any') {
    const interval = Number(step)
    const steps = (value - Number(min)) / interval
    if (!Number.isFinite(steps) || interval <= 0 || Math.abs(steps - Math.round(steps)) > 1e-7) {
      return { valid: false, reason: 'step' }
    }
    return { valid: true, value: Number(value.toFixed(Math.min(12, Math.max(decimals(min), decimals(interval))))) }
  }
  return { valid: true, value }
}

export function rangeValueEvent(value, event, identity = {}) {
  const target = { ...identity, value: String(value) }
  return {
    type: event?.type || 'change', target, currentTarget: target,
    nativeEvent: event?.nativeEvent || event,
    key: event?.key, pointerId: event?.pointerId, button: event?.button,
    preventDefault: () => event?.preventDefault?.(),
    stopPropagation: () => event?.stopPropagation?.(),
  }
}

export function createRangeGesture(getCallbacks, initialValue, identity = {}) {
  let active = null
  let latest = initialValue
  function finish(reason, event) {
    if (!active) return
    const previous = active
    active = null
    const callbacks = getCallbacks()
    const handler = reason === 'cancel' ? callbacks.onPointerCancel || callbacks.onPointerUp || callbacks.onBlur
      : reason === 'blur' ? callbacks.onBlur || callbacks.onPointerUp || callbacks.onKeyUp
      : previous === 'key' ? callbacks.onKeyUp || callbacks.onBlur || callbacks.onPointerUp
      : callbacks.onPointerUp || callbacks.onBlur || callbacks.onKeyUp
    handler?.(rangeValueEvent(latest, event, identity))
  }
  function begin(kind, event) {
    if (active) return
    active = kind
    const callbacks = getCallbacks()
    if (kind === 'key') callbacks.onKeyDown?.(event)
    else callbacks.onPointerDown?.(event || rangeValueEvent(latest, undefined, identity))
  }
  return {
    begin, finish,
    update(value, event) {
      const standalone = !active
      if (standalone) begin('value', event)
      latest = value
      getCallbacks().onChange?.(rangeValueEvent(value, event, identity))
      if (standalone) finish('value', event)
    },
    sync(value) { if (!active) latest = value },
    get active() { return active },
  }
}
