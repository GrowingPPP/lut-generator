import { useRef, useState } from 'react'
import SelectField from './SelectField.jsx'
import { useDialogs } from './ui/Dialog.jsx'

export default function VersionPanel({
  versions,
  busy,
  onSave,
  onRename,
  onDelete,
  onRestore,
  comparison,
  onCompare,
  onCloseCompare,
  draft,
  expanded = false,
}) {
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const { confirm, prompt } = useDialogs()
  const current = useRef(null)
  current.current = { versions, busy, onRename, onDelete }
  const choices = [{ id: 'draft', name: '当前草稿快照', params: draft.params }, ...versions]
  function select(side, id) {
    const item = choices.find((v) => String(v.id) === id)
    if (item) onCompare(side, item)
  }
  return (
    <section className="version-panel">
      <div className="section-heading">
        <h3>
          命名版本 <span>{versions.length}/20</span>
        </h3>
        {!expanded && <button className="btn" onClick={() => setOpen(!open)}>
          {open ? '收起版本' : '查看版本'}
        </button>}
      </div>
      <div className="version-save-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="版本名称，例如 暖调 / 清透"
          aria-label="版本名称"
          maxLength={100}
        />
        <button
          className="btn"
          disabled={busy || versions.length >= 20}
          onClick={async () => {
            if (await onSave(name.trim() || '未命名版本')) setName('')
          }}
        >
          保存命名版本
        </button>
      </div>
      <div className="comparison-controls">
        <label>
          A
          <SelectField
            aria-label="比较版本 A"
            value={comparison?.a?.id || ''}
            onChange={(e) => select('a', e.target.value)}
          >
            <option value="">选择版本</option>
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          B
          <SelectField
            aria-label="比较版本 B"
            value={comparison?.b?.id || ''}
            onChange={(e) => select('b', e.target.value)}
          >
            <option value="">选择版本</option>
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </SelectField>
        </label>
        <button className="btn" onClick={() => onCompare('b', choices[0])}>
          更新 B 为当前草稿
        </button>
        {comparison && (
          <button className="btn" onClick={onCloseCompare}>
            返回当前编辑
          </button>
        )}
      </div>
      {(expanded || open) && (
        <div className="version-list">
          {versions.map((v) => (
            <div key={v.id} className="version-row">
              <div>
                <strong>{v.name}</strong>
                <small>
                  {v.params.base_photo_style} · {v.created_at}
                </small>
              </div>
              <button className="btn" onClick={() => onCompare('a', v)}>
                查看 A
              </button>
              <button className="btn" disabled={busy} onClick={() => onRestore(v)}>
                恢复到草稿
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  const name = await prompt({ title: '修改版本名称', label: '版本名称', defaultValue: v.name, maxLength: 100, confirmLabel: '保存名称' })
                  const latest = current.current
                  if (name !== null && !latest.busy && latest.versions.some(version => version.id === v.id)) latest.onRename(v.id, name)
                }}
              >
                改名
              </button>
              <button
                className="btn-danger"
                disabled={busy}
                onClick={async () => {
                  const allowed = await confirm({ title: `删除版本「${v.name}」？`, description: '删除后无法恢复此命名版本，当前草稿保持原样。', confirmLabel: '删除版本', destructive: true })
                  const latest = current.current
                  if (allowed && !latest.busy && latest.versions.some(version => version.id === v.id)) latest.onDelete(v.id)
                }}
              >
                删除
              </button>
            </div>
          ))}
          {!versions.length && (
            <p className="text-muted">命名版本保存在账号中，参数内容不会被后续编辑覆盖。</p>
          )}
        </div>
      )}
    </section>
  )
}
