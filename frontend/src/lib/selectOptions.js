import { Children, Fragment, isValidElement } from 'react'

const VALUE_PREFIX = 'chroma-option:'

function optionText(children) {
  return Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return isValidElement(child) ? optionText(child.props.children) : ''
  }).join('').replace(/[\t\n\f\r ]+/g, ' ').trim()
}

export function selectOptionsFromChildren(children) {
  const options = []
  function visit(nodes, groupDisabled = false) {
    Children.forEach(nodes, child => {
      if (!isValidElement(child)) return
      if (child.type === Fragment) visit(child.props.children, groupDisabled)
      else if (child.type === 'optgroup') visit(child.props.children, groupDisabled || Boolean(child.props.disabled))
      else if (child.type === 'option') {
        const text = optionText(child.props.children)
        options.push({
          value: child.props.value == null ? text : String(child.props.value),
          label: child.props.label == null ? text : String(child.props.label),
          description: child.props.description ?? child.props['data-description'],
          disabled: groupDisabled || Boolean(child.props.disabled),
          selected: Boolean(child.props.selected),
        })
      }
    })
  }
  visit(children)
  return options
}

export function encodeSelectValue(value) {
  return VALUE_PREFIX + encodeURIComponent(String(value))
}

export function decodeSelectValue(value) {
  if (typeof value !== 'string' || !value.startsWith(VALUE_PREFIX)) return undefined
  try { return decodeURIComponent(value.slice(VALUE_PREFIX.length)) }
  catch { return undefined }
}

export function selectedSelectOption(options, value) {
  return options.find(option => option.value === String(value)) ||
    options.find(option => !option.disabled) || options[0]
}

export function initialSelectValue(options, value) {
  if (value != null) return String(value)
  return options.find(option => option.selected)?.value ??
    options.find(option => !option.disabled)?.value ?? options[0]?.value ?? ''
}
