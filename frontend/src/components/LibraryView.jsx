// 「我的 LUT」:列表、缩略图、预览、改名、下载、删除。
import { useCallback, useEffect, useMemo, useState } from 'react'

import { deleteLut, downloadLut, listLuts, updateLut, listLutRevisions } from '../lib/api.js'
import { makeThumb } from '../lib/preview.js'

async function downloadAndSave(id, mode, portable) {
  try {
    if (
      portable &&
      !window.confirm(
        '将风格应用于相同输入基准的中性参数并导出一个 LUT？若要叠加当前校正，请先载入工作区，再直接下载当前完整效果。',
      )
    )
      return
    const { blob, name } = await downloadLut(id, mode, portable ? 'neutral' : 'saved')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    alert(`下载失败:${e.message}`)
  }
}

export default function LibraryView({ onPreview }) {
  const [luts, setLuts] = useState([])
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [revisionAsset, setRevisionAsset] = useState(null)
  const [revisions, setRevisions] = useState([])

  const thumbs = useMemo(() => {
    const map = {}
    for (const lut of luts) {
      map[lut.id] = makeThumb(lut.params)
    }
    return map
  }, [luts])

  const load = useCallback(async () => {
    try {
      setLuts(await listLuts())
      setError('')
    } catch (e) {
      setError(`加载失败:${e.message}。请确认后端已启动(localhost:8000)。`)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const remove = async (id) => {
    if (!window.confirm('确定删除这个 LUT？此操作无法撤销。')) return
    try {
      await deleteLut(id)
      load()
    } catch (e) {
      setError(`删除失败:${e.message}`)
    }
  }

  const startEdit = (lut) => {
    setEditingId(lut.id)
    setEditName(lut.name)
  }

  const saveEdit = async (id) => {
    try {
      await updateLut(id, { name: editName.trim() || '未命名 LUT' })
      setEditingId(null)
      load()
    } catch (e) {
      setError(`改名失败:${e.message}`)
    }
  }
  const openRevisions = async (lut) => {
    try {
      setRevisions(await listLutRevisions(lut.id))
      setRevisionAsset(lut)
    } catch (e) {
      setError(`加载修订失败:${e.message}`)
    }
  }

  return (
    <div className="content">
      <div className="lib-head">
        <h1>我的 LUT</h1>
        <span className="count">{luts.length} 个</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="lib-grid">
        {luts.map((lut) => (
          <div key={lut.id} className="lut-card">
            <div className="card-thumb" style={{ backgroundImage: `url(${thumbs[lut.id]})` }}>
              <span className="card-badge">{lut.params.base_photo_style}</span>
            </div>
            <div className="card-body">
              {editingId === lut.id ? (
                <div className="edit-row">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <button className="btn" onClick={() => saveEdit(lut.id)}>
                    保存
                  </button>
                  <button className="btn" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <h3>{lut.name}</h3>
              )}
              <p className="card-desc">
                {lut.kind === 'portable_style' ? '可复用风格 · 相对追加' : '完整效果 · 替换参数'}
                {lut.revision_id ? ` · 修订 ${lut.revision_id}` : ''}
              </p>
              {lut.description && <p className="card-desc">{lut.description}</p>}
              <div className="card-actions">
                <button className="btn-primary" onClick={() => onPreview(lut)}>
                  {lut.kind === 'portable_style' ? '预览并追加风格' : '预览并载入完整效果'}
                </button>
                <button
                  className="btn"
                  onClick={() => downloadAndSave(lut.id, 'camera', lut.kind === 'portable_style')}
                >
                  机内版
                </button>
                <button
                  className="btn"
                  onClick={() => downloadAndSave(lut.id, 'software', lut.kind === 'portable_style')}
                >
                  后期版
                </button>
                <button className="btn" onClick={() => startEdit(lut)}>
                  编辑
                </button>
                <button className="btn" onClick={() => openRevisions(lut)}>
                  修订历史
                </button>
                <button className="btn-danger" onClick={() => remove(lut.id)}>
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
        {luts.length === 0 && !error && (
          <div className="empty">还没有 LUT,去「生成」页创建一个。</div>
        )}
      </div>
      {revisionAsset && (
        <div className="modal-backdrop">
          <section
            className="workspace-modal"
            role="dialog"
            aria-modal="true"
            aria-label="资产修订历史"
          >
            <div className="section-heading">
              <h2>「{revisionAsset.name}」的修订</h2>
              <button className="btn" onClick={() => setRevisionAsset(null)}>
                关闭
              </button>
            </div>
            <p className="workspace-note">
              查看历史修订不会覆盖资产或当前草稿；载入前会显示候选预览。
            </p>
            {revisions.map((revision) => (
              <div className="version-row" key={revision.revision_id}>
                <div>
                  <strong>{revision.name}</strong>
                  <small>
                    修订 {revision.revision_number} · {revision.created_at}
                  </small>
                </div>
                <button
                  className="btn"
                  onClick={() =>
                    onPreview({
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
          </section>
        </div>
      )}
    </div>
  )
}
