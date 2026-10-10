import { useMemo, useState } from 'react'
import { defaultParams } from '../lib/lutEngine.js'
import {
  applyStyleRecipe,
  buildStyleRecipe,
  recipeCanSave,
  pruneDependencies,
} from '../lib/styleRecipe.js'
import { RenderedImage } from './ComparisonPreview.jsx'
import { diffParams, PARAM_LABELS } from '../lib/autoGrade.js'

export default function StyleSaveDialog({
  workspace,
  image,
  compatible,
  onClose,
  onSave,
  savedAsset,
}) {
  const [kind, setKind] = useState('full_snapshot')
  const [name, setName] = useState(workspace.name || '')
  const [operations, setOperations] = useState(null)
  const [excluded, setExcluded] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [replace, setReplace] = useState(false)
  const eligibility = recipeCanSave(workspace)
  const originalOperations = workspace.recipe_projection?.operations || {}
  const candidate = useMemo(() => {
    if (kind === 'full_snapshot') return { params: workspace.params }
    try {
      const selected = Object.fromEntries(
        Object.entries(operations || originalOperations).filter(([key]) => !excluded.includes(key)),
      )
      const recipe = buildStyleRecipe(workspace, { operations: pruneDependencies(selected) })
      const neutral = {
        ...defaultParams(),
        base_photo_style: workspace.params.base_photo_style,
        tone_map: workspace.params.tone_map,
      }
      return { recipe, params: applyStyleRecipe(recipe, neutral) }
    } catch (e) {
      return { error: e.message }
    }
  }, [kind, workspace, operations, excluded])
  const changes = candidate.params ? diffParams(workspace.params, candidate.params) : []
  const submit = async () => {
    if (!candidate.params || (kind === 'portable_style' && !eligibility.allowed)) return
    setSaving(true)
    setError('')
    try {
      await onSave({
        name: name.trim() || '未命名 LUT',
        kind,
        params: candidate.params,
        recipe: candidate.recipe,
        replace,
      })
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-title"
      >
        <div className="section-heading">
          <h2 id="save-title">保存调色资产</h2>
          <button className="btn" onClick={onClose} disabled={saving}>
            关闭
          </button>
        </div>
        <label>
          资产名称
          <input
            aria-label="资产名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </label>
        <div className="asset-kind-options">
          <label>
            <input
              type="radio"
              name="asset-kind"
              value="full_snapshot"
              checked={kind === 'full_snapshot'}
              onChange={() => setKind('full_snapshot')}
            />
            单张完整效果
          </label>
          <label>
            <input
              type="radio"
              name="asset-kind"
              value="portable_style"
              checked={kind === 'portable_style'}
              onChange={() => setKind('portable_style')}
            />
            可复用风格
          </label>
        </div>
        <p className="workspace-note">
          {kind === 'full_snapshot'
            ? '保存当前全部参数，包含单张校正。载入时替换完整参数。'
            : '保存实际生效的风格贡献；追加到另一工作区的当前效果。下方预览使用同一输入基准的中性参数。'}
        </p>
        {kind === 'portable_style' && (
          <>
            {!eligibility.allowed && <p className="error">{eligibility.reasons.join('；')}</p>}
            {workspace.recipe_projection?.corrections_after_style && (
              <p className="workspace-note">
                风格形成后又发生过单张校正；可复用风格保留此前的风格贡献，下方与当前完整效果分别预览。
              </p>
            )}
            <div className="recipe-operations">
              {Object.entries(operations || originalOperations).map(([key, op]) => (
                <div className="recipe-operation" key={key}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`保留${PARAM_LABELS[key]?.[0] || key}`}
                      checked={!excluded.includes(key)}
                      disabled={op.dependency || saving}
                      onChange={(e) =>
                        setExcluded((prev) =>
                          e.target.checked ? prev.filter((k) => k !== key) : [...prev, key],
                        )
                      }
                    />
                    <span>
                      {PARAM_LABELS[key]?.[0] || key}
                      {op.dependency ? '（作用范围）' : ''}
                    </span>
                  </label>
                  <select
                    aria-label={`${PARAM_LABELS[key]?.[0] || key} 配方语义`}
                    value={op.mode}
                    disabled={op.dependency || excluded.includes(key) || saving}
                    onChange={(e) =>
                      setOperations({
                        ...(operations || originalOperations),
                        [key]: {
                          ...op,
                          mode: e.target.value,
                          value:
                            e.target.value === 'set'
                              ? workspace.params[key]
                              : originalOperations[key].value,
                        },
                      })
                    }
                  >
                    <option value="add" disabled={originalOperations[key]?.mode === 'set'}>
                      追加增量
                    </option>
                    <option value="set">固定目标</option>
                  </select>
                  <code>{JSON.stringify(op.value)}</code>
                </div>
              ))}
            </div>
            <p className="text-muted">
              排除效果项会一并移除不再使用的作用范围。输入不匹配、锁冲突或超出范围时阻止应用。
            </p>
          </>
        )}
        {candidate.error && <p className="error">{candidate.error}</p>}
        {candidate.params &&
          image &&
          compatible &&
          (kind === 'portable_style' ? (
            <div className="previews">
              <RenderedImage image={image} params={workspace.params} label="当前完整效果" />
              <RenderedImage image={image} params={candidate.params} label="中性校正上的风格" />
            </div>
          ) : (
            <RenderedImage
              image={image}
              params={candidate.params}
              label="保存候选预览 · 不修改当前草稿"
            />
          ))}
        {kind === 'portable_style' && changes.length > 0 && (
          <p className="workspace-note">
            相对当前完整效果的差异：{changes.map((c) => c.text).join('；')}
          </p>
        )}
        {savedAsset && (
          <label className="preview-cache-option">
            <input
              type="checkbox"
              checked={replace}
              onChange={(e) => setReplace(e.target.checked)}
            />
            更新「{savedAsset.name}」，保留旧修订
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={
              saving || !!candidate.error || (kind === 'portable_style' && !eligibility.allowed)
            }
          >
            {saving ? '正在保存…' : '保存到我的 LUT'}
          </button>
        </div>
      </section>
    </div>
  )
}
