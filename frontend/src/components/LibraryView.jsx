// 「我的 LUT」:列表、缩略图、预览、改名、下载、删除。
import { useCallback, useEffect, useMemo, useState } from 'react'

import { deleteLut, downloadLut, listLuts, updateLut } from '../lib/api.js'
import { makeThumb } from '../lib/preview.js'

async function downloadAndSave(id, mode) {
  try {
    const { blob, name } = await downloadLut(id, mode)
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
    await deleteLut(id)
    load()
  }

  const startEdit = (lut) => {
    setEditingId(lut.id)
    setEditName(lut.name)
  }

  const saveEdit = async (id) => {
    await updateLut(id, { name: editName.trim() || '未命名 LUT' })
    setEditingId(null)
    load()
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
              <p className="card-desc">{lut.description || '—'}</p>
              <div className="card-actions">
                <button className="btn-primary" onClick={() => onPreview(lut)}>
                  预览
                </button>
                <button className="btn" onClick={() => downloadAndSave(lut.id, 'camera')}>机内版</button>
                <button className="btn" onClick={() => downloadAndSave(lut.id, 'software')}>后期版</button>
                <button className="btn" onClick={() => startEdit(lut)}>
                  编辑
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
    </div>
  )
}
