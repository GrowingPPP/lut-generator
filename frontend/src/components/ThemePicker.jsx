import { useSyncExternalStore } from 'react'
import SelectField from './SelectField.jsx'
import { THEME_OPTIONS, getThemePreference, setThemePreference, subscribeTheme } from '../lib/theme.js'
import './ThemePicker.css'

export default function ThemePicker() {
  const preference = useSyncExternalStore(subscribeTheme, getThemePreference, () => 'dark')
  return <label className="theme-picker">
    <span>主题</span>
    <SelectField aria-label="界面主题" value={preference} onChange={event => setThemePreference(event.target.value)}>
      {THEME_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </SelectField>
  </label>
}
