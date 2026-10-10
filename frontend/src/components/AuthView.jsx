// 登录 / 注册。
import { useState } from 'react'

import { login, register } from '../lib/api.js'
import ThemePicker from './ThemePicker.jsx'

export default function AuthView({ onAuthed }) {
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!username.trim() || !password) {
      setError('请输入用户名和密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const resp = mode === 'login' ? await login(username.trim(), password) : await register(username.trim(), password)
      onAuthed(resp.username)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-theme"><ThemePicker /></div>
      <div className="auth-card">
        <div className="brand auth-brand"><span className="logo">C</span>CHROMA</div>
        <h1>{mode === 'login' ? '登录' : '注册'}</h1>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="密码" onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {error && <div className="error">{error}</div>}
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
        </button>
        <button className="btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>
          {mode === 'login' ? '没有账号?去注册' : '已有账号?去登录'}
        </button>
      </div>
    </div>
  )
}
