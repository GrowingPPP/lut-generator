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
import useModalFocus from '../hooks/useModalFocus.js'
import './LibraryView.css'

async function downloadAndSave(id, mode, portable) {
  try {
    if (
      portable &&
      !window.confirm(
        '将风格应用于相同输入基准的中性参数并导出一个 LUT？若要叠加当前校正，请先载入工作区，再直接下载当前完整效果。',
      )
    )
      return
    const { blob, name } = await downloadLut(
      id,
      mode,
      portable ? 'neutral' : 'saved',
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert(`下载失败：${e.message}`)
  }
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
        asset.cover_id === 'engine'
          ? { backgroundImage: `url(${thumb})` }
          : undefined
      }
    >
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
}) {
  const ref = useModalFocus(onClose, allowClose)
  const Panel = form ? 'form' : 'section'
  return (
    <div className="modal-backdrop">
      <Panel
        ref={ref}
        className={`workspace-modal library-modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onSubmit={onSubmit}
      >
        {children}
      </Panel>
    </div>
  )
}

export default function LibraryView({ onPreview }) {
  const [luts, setLuts] = useState([])
  const [summary, setSummary] = useState({ total: 0, groups: [] })
  const [filters, setFilters] = useState({ ...DEFAULT_LIBRARY_FILTERS })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState(null)
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [busyIds, setBusyIds] = useState([])
  const [revisionAsset, setRevisionAsset] = useState(null)
  const [revisions, setRevisions] = useState([])
  const requestId = useRef(0)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((value) => ({ ...value, q: search })),
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
    } catch (e) {
      if (requestId.current === id) setError(`加载失败：${e.message}`)
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
  const remove = async (lut) => {
    if (
      !window.confirm(`确定删除「${lut.name}」及其修订历史？此操作无法撤销。`)
    )
      return
    try {
      await deleteLut(lut.id)
      setDetail(null)
      await load()
    } catch (e) {
      setError(`删除失败：${e.message}`)
    }
  }
  const openRevisions = async (lut) => {
    try {
      setRevisions(await listLutRevisions(lut.id))
      setRevisionAsset(lut)
      setDetail(null)
    } catch (e) {
      setError(`加载修订失败：${e.message}`)
    }
  }
  const preview = (lut) => {
    setDetail(null)
    setRevisionAsset(null)
    onPreview(lut)
  }

  return (
    <div className="content library-page">
      <div className="lib-head">
        <div>
          <h1>我的 LUT</h1>
          <p className="library-intro">
            收藏你的色彩，按场景找到下一次创作的起点。
          </p>
        </div>
        <span className="count">共 {summary.total} 个</span>
      </div>
      <section className="library-tools" aria-label="资产检索">
        <label className="library-search">
          <span>搜索</span>
          <input
            type="search"
            value={search}
            maxLength={200}
            placeholder="搜索名称、适用场景或标签"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="library-filters">
          <label>
            种类
            <SelectField
              aria-label="资产种类"
              value={filters.kind}
              onChange={(e) => changeFilter('kind', e.target.value)}
            >
              <option value="">全部种类</option>
              <option value="full_snapshot">完整效果</option>
              <option value="portable_style">可复用风格</option>
            </SelectField>
          </label>
          <label>
            输入基准
            <SelectField
              aria-label="资产输入基准"
              value={filters.input}
              onChange={(e) => changeFilter('input', e.target.value)}
            >
              <option value="">全部输入</option>
              {['STD', 'NAT', 'VIVD', 'VLOG'].map((input) => (
                <option key={input}>{input}</option>
              ))}
            </SelectField>
          </label>
          <label>
            分组
            <SelectField
              aria-label="资产分组筛选"
              value={filters.group}
              onChange={(e) => changeFilter('group', e.target.value)}
            >
              <option value="all">全部分组</option>
              <option value="none">未分组</option>
              {summary.groups.map((group) => (
                <option key={group} value={`group:${group}`}>
                  {group}
                </option>
              ))}
            </SelectField>
          </label>
          <label>
            收藏
            <SelectField
              aria-label="资产收藏筛选"
              value={filters.favorite}
              onChange={(e) => changeFilter('favorite', e.target.value)}
            >
              <option value="">全部资产</option>
              <option value="true">已收藏</option>
              <option value="false">未收藏</option>
            </SelectField>
          </label>
          <label>
            排序
            <SelectField
              aria-label="资产排序"
              value={filters.sort}
              onChange={(e) => changeFilter('sort', e.target.value)}
            >
              <option value="created_desc">最近创建</option>
              <option value="created_asc">最早创建</option>
              <option value="updated_desc">最近更新</option>
              <option value="updated_asc">最早更新</option>
              <option value="name_asc">名称升序</option>
              <option value="name_desc">名称降序</option>
            </SelectField>
          </label>
        </div>
      </section>
      <div className="library-result-line">
        <span role="status">
          {loading ? '正在加载…' : `找到 ${luts.length} 个资产`}
        </span>
        <button className="btn" onClick={resetFilters}>
          清除筛选
        </button>
        <button className="btn" onClick={load} disabled={loading}>
          刷新
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="lib-grid">
        {luts.map((lut) => (
          <article key={lut.id} className="lut-card">
            <AssetCover asset={lut} thumb={thumbs[lut.id]}>
              <span className="card-badge">
                {lut.params.base_photo_style || 'STD'}
              </span>
              <button
                className={`library-favorite ${lut.favorite ? 'is-favorite' : ''}`}
                aria-label={`${lut.favorite ? '取消收藏' : '收藏'}「${lut.name}」`}
                aria-pressed={lut.favorite}
                disabled={busyIds.includes(lut.id)}
                onClick={() => toggleFavorite(lut)}
              >
                {lut.favorite ? '★' : '☆'}
              </button>
            </AssetCover>
            <div className="card-body">
              <div className="library-card-title">
                <h3>{lut.name}</h3>
                <span>{kindLabel(lut)}</span>
              </div>
              {lut.group && <p className="library-group">{lut.group}</p>}
              <p className="card-desc library-scene">
                {lut.description || '尚未填写适用场景'}
              </p>
              {lut.tags.length > 0 && (
                <div className="library-tags">
                  {lut.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
              <small className="library-updated">
                更新于 {dateLabel(lut.updated_at)}
              </small>
              <div className="card-actions">
                <button className="btn-primary" onClick={() => preview(lut)}>
                  {lut.kind === 'portable_style'
                    ? '预览并追加风格'
                    : '预览并载入完整效果'}
                </button>
                <button className="btn" onClick={() => setDetail(lut)}>
                  详情与导出
                </button>
                <button className="btn" onClick={() => openEdit(lut)}>
                  编辑信息
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!loading && !error && luts.length === 0 && (
        <div className="library-empty">
          <h2>
            {summary.total === 0
              ? '你的色彩收藏，从这里开始'
              : '没有匹配的资产'}
          </h2>
          <p>
            {summary.total === 0
              ? '在「生成」工作区保存完整效果或可复用风格，它们会出现在这里。'
              : '试试其他关键词，或清除种类、输入与收藏筛选。'}
          </p>
          {summary.total > 0 && (
            <button className="btn-primary" onClick={resetFilters}>
              查看全部资产
            </button>
          )}
        </div>
      )}
      {detail && (
        <LibraryModal label="资产详情" onClose={() => setDetail(null)}>
          <div className="section-heading">
            <h2>{detail.name}</h2>
            <button className="btn" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
          <AssetCover
            asset={detail}
            thumb={
              detail.cover_id === 'engine' && !detail.preview_error ? makeThumb(detail.params) : null
            }
          />
          <dl className="library-detail">
            <div>
              <dt>种类</dt>
              <dd>
                {kindLabel(detail)} ·{' '}
                {detail.kind === 'portable_style' ? '相对追加' : '替换参数'}
              </dd>
            </div>
            <div>
              <dt>输入基准</dt>
              <dd>
                {detail.params.base_photo_style || 'STD'} ·{' '}
                {detail.input_contract?.output_encoding ||
                  (detail.params.base_photo_style === 'VLOG'
                    ? 'Rec709'
                    : 'sRGB')}
              </dd>
            </div>
            <div>
              <dt>分组</dt>
              <dd>{detail.group || '未分组'}</dd>
            </div>
            <div>
              <dt>标签</dt>
              <dd>{detail.tags.join(' · ') || '暂无标签'}</dd>
            </div>
            <div>
              <dt>收藏</dt>
              <dd>{detail.favorite ? '已收藏' : '未收藏'}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{dateLabel(detail.created_at)}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{dateLabel(detail.updated_at)}</dd>
            </div>
          </dl>
          <div className="library-detail-scene">
            <h3>适用场景</h3>
            <p>{detail.description || '尚未填写适用场景'}</p>
          </div>
          <p className="workspace-note">
            {detail.kind === 'portable_style'
              ? '库内导出将风格应用于中性参数。叠加校正后的完整效果，请在工作区导出。'
              : '库内导出使用已保存的完整参数。'}{' '}
            载入前会显示候选预览。
          </p>
          <div className="library-modal-actions">
            <button className="btn-primary" onClick={() => preview(detail)}>
              预览并载入
            </button>
            <button
              className="btn"
              onClick={() =>
                downloadAndSave(
                  detail.id,
                  'camera',
                  detail.kind === 'portable_style',
                )
              }
            >
              导出机内版
            </button>
            <button
              className="btn"
              onClick={() =>
                downloadAndSave(
                  detail.id,
                  'software',
                  detail.kind === 'portable_style',
                )
              }
            >
              导出后期版
            </button>
            <button className="btn" onClick={() => openEdit(detail)}>
              编辑信息
            </button>
            <button className="btn" onClick={() => openRevisions(detail)}>
              调色修订历史
            </button>
            <button className="btn-danger" onClick={() => remove(detail)}>
              删除资产
            </button>
          </div>
        </LibraryModal>
      )}
      {editing && (
        <LibraryModal
          form
          label="编辑资产信息"
          className="library-editor"
          onSubmit={saveEdit}
          onClose={() => setEditing(null)}
          allowClose={!saving}
        >
          <div className="section-heading">
            <h2>编辑资产信息</h2>
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>
          <label>
            名称
            <input
              autoFocus
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
            <input
              type="checkbox"
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
          label="资产修订历史"
          onClose={() => setRevisionAsset(null)}
        >
          <div className="section-heading">
            <h2>「{revisionAsset.name}」的调色修订</h2>
            <button className="btn" onClick={() => setRevisionAsset(null)}>
              关闭
            </button>
          </div>
          <p className="workspace-note">
            查看历史修订不会覆盖资产或当前草稿；载入前会显示候选预览。信息编辑不产生调色修订。
          </p>
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
                className="btn"
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
