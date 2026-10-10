const GOALS = [
  ['preserve', '保留氛围', '基础校正保留全局曝光、冷暖与绿洋红；明确的风格要求可调整未锁定项。'],
  ['natural', '自然校正', '按照片测量结果克制地校正亮度、色偏和影调。'],
  ['style_only', '只调整风格', '跳过基础校正，需要填写风格描述；失败时保留当前效果。'],
]
const SAVE_STATES = {
  loading: '正在恢复草稿',
  saving: '草稿保存中',
  saved: '草稿已保存到本机',
  unsaved: '当前修改未保存',
  conflict: '另一标签页已更新草稿',
}

export default function WorkspaceToolbar({ editor, busy, onNew, onBackup, onHistory, mode = 'full' }) {
  const {
    workspace,
    setGoal,
    setPurpose,
    undo,
    redo,
    canUndo,
    canRedo,
    saveStatus,
    error,
    conflict,
    fork,
    flush,
  } = editor
  const showHeader = mode !== 'context'
  const showContext = mode !== 'header'
  const purposeControl = (
    <label className="purpose-select">
      本次手调与对话用途
      <select
        aria-label="本次调整用途"
        value={workspace.purpose || 'default'}
        onChange={(e) => setPurpose(e.target.value)}
        disabled={busy}
      >
        <option value="default">按参数组默认</option>
        <option value="correction">单张校正</option>
        <option value="style">风格调整</option>
      </select>
    </label>
  )
  return (
    <section className={`workspace-toolbar workspace-toolbar-${mode}`}>
      <div className="workspace-toolbar-row">
        {showContext && <label>
          创作目标
          <select
            aria-label="创作目标"
            value={workspace.goal_mode}
            onChange={(e) => setGoal(e.target.value)}
            disabled={busy}
          >
            {GOALS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>}
        {showHeader && <span className={`draft-status ${saveStatus}`} role="status">
          {SAVE_STATES[saveStatus] || saveStatus}
        </span>}
        {showHeader && <div className="workspace-history">
          <button className="btn" onClick={() => { undo(); onHistory?.('undo') }} disabled={!canUndo || busy}>
            撤销
          </button>
          <button className="btn" onClick={() => { redo(); onHistory?.('redo') }} disabled={!canRedo || busy}>
            重做
          </button>
          <button className="btn" onClick={onNew} disabled={busy}>
            新工作区
          </button>
        </div>}
      </div>
      {showContext && <p className="workspace-note">
        {GOALS.find(([v]) => v === workspace.goal_mode)?.[2]} · 已保护{' '}
        {workspace.locked_fields.length} 项参数
      </p>}
      {showContext && (mode === 'context' ? (
        <details className="workspace-advanced">
          <summary>高级设置 · 调整贡献归类</summary>
          <p className="workspace-note">记录单张校正和风格贡献，用于后续保存可复用风格。</p>
          {purposeControl}
        </details>
      ) : purposeControl)}
      {showHeader && (error || conflict) && (
        <div className="draft-error" role="alert">
          {error?.message || '检测到其他标签页的更新，已暂停覆盖。'}
          <div className="workspace-toolbar-row">
            <button className="btn" disabled={busy} onClick={() => (conflict ? fork() : flush())}>
              {conflict ? '另存本机副本' : '重试保存'}
            </button>
            <button className="btn" onClick={onBackup}>
              下载参数备份
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
