import CheckboxField from './ui/CheckboxField.jsx'
import ActionMenu from './ui/ActionMenu.jsx'
import ActionIcon from './ui/ActionIcon.jsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SelectField from './SelectField.jsx'

import {
  deleteLut,
  downloadLut,
  getLibrarySummary,
  listLuts,
  listLutRevisions,
  updateLutMetadata,
} from '../lib/api.js'
import {
  COVER_OPTIONS,
  DEFAULT_LIBRARY_FILTERS,
  metadataPatch,
  normalizeAsset,
} from '../lib/assetLibrary.js'
import { preloadExternalLut } from '../lib/importedLuts.js'
import { makeThumb } from '../lib/preview.js'
import { AlertSurface, ModalSurface, useDialogs } from './ui/Dialog.jsx'
import './LibraryView.css'

async function downloadAndSave(id, mode, portable) {
  const { blob, name } = await downloadLut(id, mode, portable ? 'neutral' : 'saved')
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
  } finally { URL.revokeObjectURL(url) }
}

const kindLabel = (asset) =>
  asset.kind === 'portable_style' ? '可复用风格' : '完整效果'
const dateLabel = (value) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
const draftOf = (asset) => ({
  name: asset.name,
  description: asset.description || '',
  tags: asset.tags.join('，'),
  group: asset.group || '',
  favorite: asset.favorite,
  cover_id: asset.cover_id,
})

function AssetCover({ asset, thumb, children }) {
  return (
    <div
      className={`card-thumb library-cover library-cover-${asset.cover_id}`}
      style={
        asset.cover_id === 'engine' && thumb
          ? { backgroundImage: `url(${thumb})` }
          : undefined
      }
    >
      {asset.cover_id === 'engine' && !thumb && (
        <span className="library-cover-unavailable">封面暂不可用</span>
      )}
      {children}
    </div>
  )
}

function LibraryModal({
  children,
  label,
  onClose,
  allowClose = true,
  form = false,
  onSubmit,
  className = '',
  busy = false,
  describedBy,
  destructive = false,
  initialFocusRef,
}) {
  const Panel = form ? 'form' : 'section'
  const Surface = destructive ? AlertSurface : ModalSurface
  return (
    <Surface onClose={onClose} busy={busy || !allowClose} initialFocusRef={initialFocusRef}>
      <Panel
        className={`workspace-modal library-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        aria-busy={busy || !allowClose || undefined}
        tabIndex={-1}
        onSubmit={onSubmit}
      >
        {children}
      </Panel>
    </Surface>
  )
}

export default function LibraryView({ onPreview, onDeleted, onCreate }) {
  const { confirm } = useDialogs()
  const [luts, setLuts] = useState([])
  const [summary, setSummary] = useState({ total: 0, groups: [] })
  const [filters, setFilters] = useState({ ...DEFAULT_LIBRARY_FILTERS })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const deleteInFlight = useRef(false)
  const resultsRef = useRef(null)
  const [detail, setDetail] = useState(null)
  const [downloadError, setDownloadError] = useState('')
  const [downloadNotice, setDownloadNotice] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(null)
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [busyIds, setBusyIds] = useState([])
  const [revisionAsset, setRevisionAsset] = useState(null)
  const [revisions, setRevisions] = useState([])
  const [revisionLoading, setRevisionLoading] = useState(false)
  const [revisionError, setRevisionError] = useState('')
  const revisionRequestId = useRef(0)
  const requestId = useRef(0)
  const filtersRef = useRef(filters)
  const deleteCancelRef = useRef(null)
  const editingNameRef = useRef(null)
  filtersRef.current = filters

  useEffect(() => { setDownloadError(''); setDownloadNotice('') }, [detail?.id])
  useEffect(() => () => { revisionRequestId.current += 1 }, [])

  useEffect(() => {
    const active = document.activeElement
    if (notice && !deleteTarget && !deleting && (!active || active === document.body || !active.isConnected)) {
      resultsRef.current?.focus()
    }
  }, [notice, deleteTarget, deleting])

  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((value) => value.q === search ? value : { ...value, q: search }),
      250,
    )
    return () => clearTimeout(timer)
  }, [search])
  const load = useCallback(async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const [assets, info] = await Promise.all([
        listLuts(filtersRef.current),
        getLibrarySummary(),
      ])
      const loaded = await Promise.all(assets.map(async (asset) => {
        try { await preloadExternalLut(asset.params?.external_lut_id); return normalizeAsset(asset) }
        catch (failure) { return { ...normalizeAsset(asset), preview_error: failure.message } }
      }))
      if (requestId.current !== id) return
      setLuts(loaded)
      setSummary(info)
      setError('')
      return true
    } catch (e) {
      if (requestId.current === id) {
        setError(`加载失败：${e.message}`)
        return false
      }
    } finally {
      if (requestId.current === id) setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
    return () => {
      requestId.current += 1
    }
  }, [load, filters])
  const thumbs = useMemo(
    () =>
      Object.fromEntries(
        luts
          .filter((lut) => lut.cover_id === 'engine')
          .map((lut) => [lut.id, lut.preview_error ? null : makeThumb(lut.params)]),
      ),
    [luts],
  )
  const changeFilter = (name, value) =>
    setFilters((current) => ({ ...current, [name]: value }))
  const resetFilters = () => {
    setSearch('')
    setFilters({ ...DEFAULT_LIBRARY_FILTERS })
  }
  const openEdit = (lut) => {
    setEditing(lut)
    setDraft(draftOf(lut))
    setEditError('')
    setDetail(null)
  }
  const changeDraft = (name, value) =>
    setDraft((current) => ({ ...current, [name]: value }))
  const saveEdit = async (e) => {
    e.preventDefault()
    setEditError('')
    try {
      const patch = metadataPatch(editing, draft)
      if (!Object.keys(patch).length) {
        setEditing(null)
        return
      }
      setSaving(true)
      await updateLutMetadata(editing.id, {
        ...patch,
        ...(editing.revision_id ? { revision_id: editing.revision_id } : {}),
      })
      setEditing(null)
      await load()
    } catch (e) {
      setEditError(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }
  const toggleFavorite = async (lut) => {
    setBusyIds((ids) => [...ids, lut.id])
    try {
      await updateLutMetadata(lut.id, { favorite: !lut.favorite })
      await load()
    } catch (e) {
      setError(`收藏更新失败：${e.message}`)
    } finally {
      setBusyIds((ids) => ids.filter((id) => id !== lut.id))
    }
  }
  const openDelete = (lut) => {
    if (deleteInFlight.current || busyIds.includes(lut.id)) return
    setDeleteTarget(lut)
    setDeleteError('')
    setNotice('')
  }
  const closeDelete = () => {
    if (deleteInFlight.current) return
    setDeleteTarget(null)
    setDeleteError('')
  }
  const remove = async () => {
    if (!deleteTarget || deleteInFlight.current) return
    const lut = deleteTarget
    deleteInFlight.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      try { await deleteLut(lut.id) }
      catch (failure) { if (failure.status !== 404) throw failure }
      requestId.current += 1
      setLuts((current) => current.filter((asset) => asset.id !== lut.id))
      setSummary((current) => ({ ...current, total: Math.max(0, current.total - 1) }))
      setDetail(null)
      setRevisionAsset(null)
      setDeleteTarget(null)
      setNotice(`「${lut.name}」已从我的 LUT 中删除`)
      onDeleted?.(lut.id)
      const refreshed = await load()
      if (refreshed === false) setNotice(`「${lut.name}」已删除，列表刷新失败，请点击刷新。`)
    } catch (e) {
      setDeleteError(`删除失败：${e.message}`)
    } finally {
      deleteInFlight.current = false
      setDeleting(false)
    }
  }
  const closeRevisions = () => {
    revisionRequestId.current += 1
    setRevisionAsset(null)
  }
  const openRevisions = async (lut) => {
    const id = ++revisionRequestId.current
    setRevisionAsset(lut)
    setDetail(null)
    setRevisions([])
    setRevisionError('')
    setRevisionLoading(true)
    try {
      const loaded = await listLutRevisions(lut.id)
      if (revisionRequestId.current === id) setRevisions(loaded)
    } catch (e) {
      if (revisionRequestId.current === id) setRevisionError(`加载修订失败：${e.message}`)
    } finally {
      if (revisionRequestId.current === id) setRevisionLoading(false)
    }
  }
  const preview = (lut) => {
    setDetail(null)
    closeRevisions()
    onPreview(lut)
  }
  const activeFilters = Boolean(search.trim() || filters.kind || filters.input || filters.favorite || filters.group !== 'all')
  const moreFilterCount = Number(Boolean(filters.input)) + Number(filters.group !== 'all')
  const assetMenuItems = (asset) => [
    { id: 'edit', label: '编辑作品信息', description: '名称、用途、标签与封面', onSelect: () => openEdit(asset) },
    { id: 'revisions', label: '调色修订历史', onSelect: () => openRevisions(asset) },
    { id: 'delete', label: '删除作品', description: '保留调色项目和已导出文件', separator: true, destructive: true,
      disabled: busyIds.includes(asset.id), onSelect: () => openDelete(asset) },
  ]
  const downloadAsset = async (asset, mode) => {
    if (downloading) return
    setDownloadError('')
    setDownloadNotice('')
    const portable = asset.kind === 'portable_style'
    if (portable && !(await confirm({ title: '导出中性参数上的风格？',
      description: '将风格应用于相同输入基准的中性参数并导出一个 LUT。若要叠加当前校正，请先载入调色项目，再直接下载当前完整效果。',
      confirmLabel: '导出风格' }))) return
    setDownloading(true)
    try {
      await downloadAndSave(asset.id, mode, portable)
      setDownloadNotice(`已发起「${asset.name}」${mode === 'camera' ? '相机版' : '后期版'} .cube 下载，请在浏览器下载记录中查看。`)
    }
    catch (failure) { setDownloadError(`下载失败：${failure.message}`) }
    finally { setDownloading(false) }
  }

  return (
    <div className="content library-page">
      <header className="lib-head">
        <div>
          <p className="library-eyebrow">你的色彩作品</p>
          <h1>我的 LUT</h1>
          <p className="library-intro">把喜欢的色彩保存下来，成为下一次创作的起点。</p>
        </div>
        {onCreate && <button className="btn-primary" onClick={onCreate}>开始创作</button>}
      </header>
      <section className="library-tools" aria-label="作品检索">
        <div className="library-search-row">
          <label className="library-search">
            <span>搜索作品</span>
            <input type="search" value={search} maxLength={200}
              placeholder="名称、适用场景或标签" onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label>
            作品类型
            <SelectField aria-label="资产种类" value={filters.kind} onChange={(e) => changeFilter('kind', e.target.value)}>
              <option value="">全部类型</option>
              <option value="full_snapshot">完整效果</option>
              <option value="portable_style">可复用风格</option>
            </SelectField>
          </label>
          <label>
            收藏
            <SelectField aria-label="资产收藏筛选" value={filters.favorite} onChange={(e) => changeFilter('favorite', e.target.value)}>
              <option value="">全部作品</option>
              <option value="true">已收藏</option>
              <option value="false">未收藏</option>
            </SelectField>
          </label>
          <label>
            排序
            <SelectField aria-label="资产排序" value={filters.sort} onChange={(e) => changeFilter('sort', e.target.value)}>
              <option value="created_desc">最近创建</option>
              <option value="created_asc">最早创建</option>
              <option value="updated_desc">最近更新</option>
              <option value="updated_asc">最早更新</option>
              <option value="name_asc">名称升序</option>
              <option value="name_desc">名称降序</option>
            </SelectField>
          </label>
        </div>
        <details className="library-more-filters">
          <summary>更多筛选{moreFilterCount > 0 && <span> · 已选择 {moreFilterCount} 项</span>}</summary>
          <div className="library-filters">
            <label>
              输入基准
              <SelectField aria-label="资产输入基准" value={filters.input} onChange={(e) => changeFilter('input', e.target.value)}>
                <option value="">全部输入</option>
                {['STD', 'NAT', 'VIVD', 'VLOG'].map((input) => <option key={input}>{input}</option>)}
              </SelectField>
            </label>
            <label>
              分组
              <SelectField aria-label="资产分组筛选" value={filters.group} onChange={(e) => changeFilter('group', e.target.value)}>
                <option value="all">全部分组</option>
                <option value="none">未分组</option>
                {filters.group.startsWith('group:') && !summary.groups.includes(filters.group.slice(6)) && (
                  <option value={filters.group}>{filters.group.slice(6)}（暂无作品）</option>
                )}
                {summary.groups.map((group) => <option key={group} value={`group:${group}`}>{group}</option>)}
              </SelectField>
            </label>
          </div>
        </details>
      </section>
      <div className="library-result-line">
        <span ref={resultsRef} role="status" tabIndex={-1}>
          {loading ? '正在加载作品…' : error ? '列表更新失败' : `共 ${summary.total} 个作品 · 当前显示 ${luts.length} 个`}
        </span>
        {activeFilters && <button className="btn btn-ghost btn-sm" onClick={resetFilters}>清除筛选</button>}
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>刷新</button>
      </div>
      {error && <div className="library-error" role="alert"><p>{error}</p><button className="btn" onClick={load} disabled={loading}>重新加载</button></div>}
      {notice && <p className="library-notice" role="status">{notice}</p>}
      {loading && luts.length === 0 && <div className="library-loading" role="status"><ActionIcon name="image" /><p>正在取回你的色彩作品…</p></div>}
      <div className="lib-grid" aria-label="已保存的 LUT 作品" aria-busy={loading}>
        {luts.map((lut) => (
          <article key={lut.id} className="lut-card">
            <AssetCover asset={lut} thumb={thumbs[lut.id]}>
              <span className="card-badge">{lut.params.base_photo_style || 'STD'} 输入</span>
              <button className={`library-favorite ${lut.favorite ? 'is-favorite' : ''}`}
                aria-label={`${lut.favorite ? '取消收藏' : '收藏'}「${lut.name}」`} aria-pressed={lut.favorite}
                disabled={deleting || busyIds.includes(lut.id)} onClick={() => toggleFavorite(lut)}>
                <ActionIcon name="star" />
              </button>
            </AssetCover>
            <div className="card-body">
              <div className="library-card-title">
                <h2 title={lut.name}>{lut.name}</h2>
                <span>{kindLabel(lut)}</span>
              </div>
              <p className="card-desc library-scene">{lut.description || (lut.kind === 'portable_style' ? '在兼容输入上追加这份色彩风格' : '重现保存时的完整调色效果')}</p>
              <div className="library-tags">
                {lut.group && <span className="library-group">{lut.group}</span>}
                {lut.tags.map((tag) => <span key={tag}>{tag}</span>)}
              </div>
              {lut.preview_error && <p className="library-preview-warning">外部 LUT 预览暂不可用：{lut.preview_error}</p>}
              <div className="library-card-footer">
                <small className="library-updated">更新于 {dateLabel(lut.updated_at)}</small>
                <div className="card-actions">
                  <button className="btn btn-soft" disabled={deleting} onClick={() => preview(lut)}>
                    {lut.kind === 'portable_style' ? '试用风格' : '试用完整效果'}
                  </button>
                  <button className="btn btn-ghost" disabled={deleting} onClick={() => setDetail(lut)}>详情</button>
                  <ActionMenu label={`管理「${lut.name}」`} disabled={deleting || busyIds.includes(lut.id)}
                    trigger={<button className="btn btn-ghost btn-icon" aria-label={`管理「${lut.name}」`}><ActionIcon name="more" /></button>}
                    items={assetMenuItems(lut)} />
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!loading && !error && luts.length === 0 && <div className="library-empty">
        <ActionIcon name="image" />
        <h2>{summary.total === 0 ? '保存你的第一份色彩作品' : '没有找到匹配的作品'}</h2>
        <p>{summary.total === 0
          ? '在「开始创作」中调出喜欢的效果，再保存到我的 LUT。照片与调色项目草稿会单独保留。'
          : '换个关键词，或清除筛选看看其他作品。'}</p>
        {summary.total > 0 ? <button className="btn-primary" onClick={resetFilters}>查看全部作品</button>
          : onCreate && <button className="btn-primary" onClick={onCreate}>开始创作</button>}
      </div>}
      {detail && !deleteTarget && (
        <LibraryModal label="作品详情" onClose={() => setDetail(null)} busy={downloading}>
          <div className="section-heading library-modal-heading">
            <div><p className="library-eyebrow">{kindLabel(detail)}</p><h2>{detail.name}</h2></div>
            <button className="btn btn-ghost btn-icon" aria-label="关闭作品详情" disabled={downloading} onClick={() => setDetail(null)}><ActionIcon name="close" /></button>
          </div>
          <AssetCover asset={detail} thumb={detail.cover_id === 'engine' && !detail.preview_error ? makeThumb(detail.params) : null} />
          <div className="library-detail-scene"><h3>适用场景</h3><p>{detail.description || '尚未填写适用场景'}</p></div>
          <dl className="library-detail">
            <div><dt>使用方式</dt><dd>{detail.kind === 'portable_style' ? '追加风格，保留当前单张校正' : '载入保存的完整参数'}</dd></div>
            <div><dt>输入条件</dt><dd>{detail.params.base_photo_style || 'STD'} 输入 → {detail.input_contract?.output_encoding || (detail.params.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB')} 输出</dd></div>
            <div><dt>分组</dt><dd>{detail.group || '未分组'}</dd></div>
            <div><dt>标签</dt><dd>{detail.tags.join(' · ') || '暂无标签'}</dd></div>
            <div><dt>收藏</dt><dd>{detail.favorite ? '已收藏' : '未收藏'}</dd></div>
            <div><dt>创建时间</dt><dd>{dateLabel(detail.created_at)}</dd></div>
            <div><dt>更新时间</dt><dd>{dateLabel(detail.updated_at)}</dd></div>
          </dl>
          <p className="workspace-note">{detail.kind === 'portable_style'
            ? '库内下载将风格应用于中性参数；叠加校正后的完整效果，请在调色项目中导出。'
            : '库内下载使用已保存的完整参数。'} 试用会先显示候选预览，确认后才改变调色项目。</p>
          {detail.preview_error && <p className="library-preview-warning">外部 LUT 预览暂不可用：{detail.preview_error}</p>}
          {downloadError && <p className="error" role="alert">{downloadError}</p>}
          {downloadNotice && <p className="library-notice" role="status">{downloadNotice}</p>}
          {downloading && <p role="status">正在下载到电脑，请稍候…</p>}
          <div className="library-modal-actions library-detail-actions">
            <button className="btn-primary" disabled={downloading} onClick={() => preview(detail)}>{detail.kind === 'portable_style' ? '预览并追加风格' : '预览并载入完整效果'}</button>
            <ActionMenu label="下载 LUT" disabled={downloading}
              trigger={<button className="btn">下载 .cube <span aria-hidden="true">⌄</span></button>}
              items={[
                { id: 'camera', label: '下载相机版', description: '用于支持 LUT 的 Lumix 相机', onSelect: () => downloadAsset(detail, 'camera') },
                { id: 'software', label: '下载后期版', description: '用于兼容 .cube 的后期软件', onSelect: () => downloadAsset(detail, 'software') },
              ]} />
            <ActionMenu label="管理作品" disabled={downloading || busyIds.includes(detail.id)}
              trigger={<button className="btn btn-ghost">管理作品 <span aria-hidden="true">⌄</span></button>}
              items={assetMenuItems(detail)} />
          </div>
        </LibraryModal>
      )}
      {deleteTarget && (
        <LibraryModal label="删除 LUT" className="library-delete-modal" onClose={closeDelete}
          busy={deleting} destructive initialFocusRef={deleteCancelRef} describedBy="library-delete-description">
          <h2>删除这个 LUT？</h2>
          <div className="library-delete-target">
            <strong>{deleteTarget.name}</strong>
            <span>{kindLabel(deleteTarget)} · {deleteTarget.params.base_photo_style || 'STD'}</span>
          </div>
          <div id="library-delete-description" className="library-delete-description">
            <p>将永久删除此资产及全部调色修订，无法撤销。</p>
            <p>已载入的调整效果、调色项目草稿、保存版本和已导出的文件会保留。</p>
          </div>
          {deleteError && <p className="error" role="alert">{deleteError}</p>}
          {deleting && <p className="library-delete-progress" role="status">正在删除，请稍候…</p>}
          <div className="library-modal-actions library-delete-actions">
            <button ref={deleteCancelRef} className="btn btn-ghost" disabled={deleting} onClick={closeDelete}>取消</button>
            <button className="btn-danger library-delete-confirm" disabled={deleting} onClick={remove}>
              {deleting ? '正在删除…' : '确认删除'}
            </button>
          </div>
        </LibraryModal>
      )}
      {editing && (
        <LibraryModal
          form
          label="编辑作品信息"
          className="library-editor"
          onSubmit={saveEdit}
          onClose={() => setEditing(null)}
          allowClose={!saving}
          initialFocusRef={editingNameRef}
        >
          <div className="section-heading">
            <h2>编辑作品信息</h2>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>
          <label>
            名称
            <input
              ref={editingNameRef}
              value={draft.name}
              maxLength={255}
              required
              disabled={saving}
              onChange={(e) => changeDraft('name', e.target.value)}
            />
          </label>
          <label>
            适用场景
            <textarea
              value={draft.description}
              maxLength={4000}
              rows={3}
              disabled={saving}
              placeholder="例如：阴天街拍、暖光室内人像"
              onChange={(e) => changeDraft('description', e.target.value)}
            />
          </label>
          <label>
            标签
            <input
              value={draft.tags}
              disabled={saving}
              onChange={(e) => changeDraft('tags', e.target.value)}
              placeholder="用逗号分隔，例如：人像，电影感"
            />
            <small>最多 12 个，每个最多 24 个字符。</small>
          </label>
          <label>
            分组
            <input
              list="library-groups"
              value={draft.group}
              maxLength={48}
              disabled={saving}
              placeholder="选已有分组或创建一个；留空为未分组"
              onChange={(e) => changeDraft('group', e.target.value)}
            />
            <datalist id="library-groups">
              {summary.groups.map((group) => (
                <option key={group} value={group} />
              ))}
            </datalist>
          </label>
          <label className="library-check">
            <CheckboxField
              checked={draft.favorite}
              disabled={saving}
              onChange={(e) => changeDraft('favorite', e.target.checked)}
            />
            加入收藏
          </label>
          <fieldset className="library-cover-picker" disabled={saving}>
            <legend>封面</legend>
            <p>仅保存内置封面选项，不上传或保存样张。</p>
            {COVER_OPTIONS.map((cover) => (
              <label
                key={cover.id}
                className={`library-cover-choice library-cover-${cover.id} ${draft.cover_id === cover.id ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="cover"
                  value={cover.id}
                  checked={draft.cover_id === cover.id}
                  onChange={() => changeDraft('cover_id', cover.id)}
                />
                <span>{cover.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="workspace-note">
            编辑信息不会改变调色参数，也不会增加调色修订。
          </p>
          {editError && (
            <div className="error" role="alert">
              {editError}
            </div>
          )}
          <button className="btn-primary" disabled={saving} type="submit">
            {saving ? '正在保存…' : '保存信息'}
          </button>
        </LibraryModal>
      )}
      {revisionAsset && (
        <LibraryModal
          label="作品修订历史"
          onClose={closeRevisions}
        >
          <div className="section-heading">
            <h2>「{revisionAsset.name}」的调色修订</h2>
            <button className="btn btn-ghost" onClick={closeRevisions}>
              关闭
            </button>
          </div>
          <p className="workspace-note">
            查看历史修订不会覆盖资产或当前草稿；载入前会显示候选预览。信息编辑不产生调色修订。
          </p>
          {revisionLoading && <p role="status" className="library-revision-status">正在加载调色修订…</p>}
          {revisionError && <div className="library-error" role="alert"><p>{revisionError}</p><button className="btn" onClick={() => openRevisions(revisionAsset)}>重试</button></div>}
          {!revisionLoading && !revisionError && revisions.length === 0 && <p className="library-revision-status">暂无调色修订。</p>}
          {revisions.map((revision) => (
            <div className="version-row" key={revision.revision_id}>
              <div>
                <strong>{revision.name}</strong>
                <small>
                  修订 {revision.revision_number} ·{' '}
                  {dateLabel(revision.created_at)}
                </small>
              </div>
              <button
                className="btn btn-soft"
                onClick={() =>
                  preview({
                    ...revision,
                    id: revisionAsset.id,
                    revision_id: revision.revision_id,
                  })
                }
              >
                预览此修订
              </button>
            </div>
          ))}
        </LibraryModal>
      )}
    </div>
  )
}
