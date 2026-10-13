// 登录 / 注册。
import { useState } from 'react'

import { login, register } from '../lib/api.js'
import ThemePicker from './ThemePicker.jsx'
import './AuthView.css'

export default function AuthView({ onAuthed, onBack, destination = '创作' }) {
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
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
      setError(e.message || '暂时无法完成，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap auth-page">
      <header className="auth-page-header">
        <div className="brand"><span className="logo">C</span>CHROMA</div>
        <div className="auth-page-header-actions">
          <ThemePicker />
          {onBack && <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>返回首页</button>}
        </div>
      </header>
      <main className="auth-page-main">
        <section className="auth-card" aria-labelledby="auth-title">
          <p className="auth-eyebrow">继续你的色彩创作</p>
          <h1 id="auth-title">{mode === 'login' ? '欢迎回来' : '创建账号'}</h1>
          <p className="auth-description">{mode === 'login' ? '登录后继续' : '注册后开始'}{destination}，把喜欢的影调保存下来。</p>
          <form className="auth-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); submit() }}>
            <label htmlFor="auth-username">用户名</label>
            <input id="auth-username" name="username" aria-label="用户名" autoComplete="username" value={username} disabled={busy}
              aria-describedby={error ? 'auth-error' : undefined}
              onChange={event => setUsername(event.target.value)} placeholder="请输入用户名" required />
            <label htmlFor="auth-password">密码</label>
            <input id="auth-password" name="password" aria-label="密码" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password} disabled={busy} onChange={event => setPassword(event.target.value)} type="password" placeholder="请输入密码" required
              aria-describedby={error ? 'auth-error' : undefined} />
            {error && <div className="error auth-error" id="auth-error" role="alert">{error}</div>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? (mode === 'login' ? '正在登录…' : '正在注册…') : mode === 'login' ? '登录并继续' : '注册并继续'}
            </button>
          </form>
          <p className="auth-switch">{mode === 'login' ? '还没有账号？' : '已有账号？'}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setPassword(''); setError('') }}>
              {mode === 'login' ? '创建账号' : '去登录'}
            </button>
          </p>
        </section>
        <p className="auth-page-note">调色项目保留编辑过程；我的 LUT 收纳已保存作品。</p>
      </main>
    </div>
  )
}
