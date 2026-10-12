import { useMemo, useState } from 'react'
import { ModalSurface } from './ui/Dialog.jsx'
import ActionMenu from './ui/ActionMenu.jsx'
import './ProjectManager.css'

export function projectName(project) {
  const name = project?.name?.trim()
  return !name || ['调色工作区', '当前调色工作区'].includes(name) ? '未命名调色项目' : name
}

function updatedLabel(value) {
  if (!value) return '本机草稿'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '本机草稿'
  return `更新于 ${new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)}`
}

export default function ProjectManager({ projects, currentId, busy, loading, error, onClose, onOpen, onNew, onRename, onDelete, onRetry }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => projects.filter(project =>
    projectName(project).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [projects, query])
  return <ModalSurface onClose={onClose} busy={busy}>
    <section className="workspace-modal project-manager" aria-labelledby="project-manager-title" aria-describedby="project-manager-description">
      <header className="project-manager-heading">
        <div><span className="project-manager-eyebrow">创作档案</span><h2 id="project-manager-title">调色项目</h2></div>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>关闭</button>
      </header>
      <p id="project-manager-description" className="project-manager-description">每个项目保留独立的调色进度。版本记录属于项目，已保存的 LUT 可重复使用。</p>
      <div className="project-manager-tools">
        <input type="search" aria-label="搜索调色项目" placeholder="搜索项目名称" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className="btn-primary" disabled={busy} onClick={onNew}>新建调色项目</button>
      </div>
      {error && <div className="project-manager-error" role="alert">{error}<button type="button" className="btn" onClick={onRetry} disabled={busy}>重试同步</button></div>}
      <div className="project-manager-list" aria-label="项目列表" aria-busy={busy || loading}>
        {filtered.map(project => <article key={project.id} className="project-manager-row" data-current={project.id === currentId || undefined}>
          <div className="project-manager-mark" aria-hidden="true">{project.id === currentId ? '●' : '◇'}</div>
          <div className="project-manager-info">
            <div className="project-manager-name"><h3>{projectName(project)}</h3>{project.id === currentId && <span>正在编辑</span>}</div>
            <p>{updatedLabel(project.updated_at || project.created_at)}{project.localOnly ? ' · 仅保存在本机' : ''}</p>
          </div>
          <div className="project-manager-actions">
            <button type="button" className="btn" disabled={busy || project.id === currentId} onClick={() => onOpen(project.id)} aria-label={`打开项目 ${projectName(project)}`}>打开</button>
            <ActionMenu label={`管理项目 ${projectName(project)}`} disabled={busy}
              trigger={<button type="button" className="btn project-row-more" aria-label={`管理项目 ${projectName(project)}`}>•••</button>}
              items={[
                { id: 'rename', label: '重命名项目', onSelect: () => onRename(project.id) },
                { id: 'delete', label: '删除项目', description: '保留已保存 LUT 和原照片', separator: true, destructive: true, onSelect: () => onDelete(project.id) },
              ]} />
          </div>
        </article>)}
        {!filtered.length && <p className="project-manager-empty">{loading ? '正在读取项目…' : query ? '没有找到匹配的项目' : '还没有调色项目，开始一次新的创作。'}</p>}
      </div>
      <footer className="project-manager-footer">原照片保留在电脑上；刷新后如需完整分辨率导出，请重新绑定原文件。</footer>
    </section>
  </ModalSurface>
}
