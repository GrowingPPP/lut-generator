import { useState } from 'react'
import { inputContract } from '../lib/styleRecipe.js'
import { photoMetadataNotes } from '../lib/photoMetadata.js'

function SampleCard({
  sample,
  media,
  selected,
  primary,
  result,
  busy,
  onSelect,
  onPrimary,
  onRemove,
  onConfirm,
  onRebind,
  onGuide,
}) {
  const [style, setStyle] = useState(sample.input_contract?.base_photo_style || 'STD')
  const metadata = photoMetadataNotes(sample.photo_metadata)
  return (
    <article className={`sample-card ${selected ? 'selected' : ''}`}>
      <button className="sample-image" onClick={onSelect} aria-label={`查看 ${sample.name}`}>
        {media?.thumbnail ? (
          <img src={media.thumbnail} alt={sample.name} />
        ) : (
          <span>需重新绑定照片</span>
        )}
        <span className="sample-tag">{primary ? '★ AI 主样张' : '验证图'}</span>
      </button>
      <strong title={sample.name}>{sample.name}</strong>
      <div className="sample-input-note">
        <strong>{metadata.camera}</strong>
        <div>{metadata.color}</div>
        {metadata.warning && <div className="metadata-warning">{metadata.warning}</div>}
      </div>
      <label>
        照片输入
        <select
          aria-label={`${sample.name} 输入基准`}
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          disabled={busy}
        >
          <option value="STD">Standard</option>
          <option value="NAT">Natural</option>
          <option value="VIVD">Vivid</option>
          <option value="VLOG">V-Log / V-Gamut</option>
        </select>
      </label>
      {!sample.input_confirmed || style !== sample.input_contract?.base_photo_style ? (
        <button
          className="btn confirm-sample"
          onClick={() =>
            onConfirm({
              ...inputContract({ base_photo_style: style, tone_map: 1 }),
              tone_map: sample.input_contract?.tone_map ?? 1,
            })
          }
          disabled={busy}
        >
          确认照片输入基准
        </button>
      ) : (
        <span className="sample-status">已确认 · {style}</span>
      )}
      {!sample.input_confirmed && (
        <div className="sample-input-help">
          {metadata.input}
          <button className="btn" onClick={onGuide}>
            如何核对输入与相机设置
          </button>
        </div>
      )}
      <div className="sample-actions">
        <button className="btn" onClick={onPrimary} disabled={busy || primary}>
          设为主样张
        </button>
        <button className="btn" onClick={onRebind} disabled={busy}>
          重新绑定
        </button>
        <button
          className="btn-danger"
          onClick={onRemove}
          disabled={busy}
          aria-label={`移除 ${sample.name}`}
        >
          移除
        </button>
      </div>
      {!media?.file && (
        <p className="text-muted">
          {media?.canvas
            ? '当前仅有缩小预览；AI 分析需绑定同一原文件。'
            : '图像未恢复，请重新绑定同一原文件。'}
        </p>
      )}
      {result && (
        <p className={`sample-validation ${result.status === 'attention' ? 'attention' : ''}`}>
          {result.summary ||
            result.label ||
            { no_new_risk: '暂未发现新增风险', attention: '待关注', unmeasurable: '无法测量' }[
              result.status
            ] ||
            result.status}
          {result.reason && ` · ${result.reason}`}
        </p>
      )}
    </article>
  )
}

export default function SampleGallery({
  samples,
  media,
  selectedId,
  primaryId,
  validation,
  stale,
  busy,
  onSelect,
  onPrimary,
  onRemove,
  onConfirm,
  onAdd,
  onRebind,
  onValidate,
  retainPreviews,
  onRetain,
  onGuide,
}) {
  return (
    <section className="sample-gallery">
      <div className="section-heading">
        <div>
          <h3>样张验证</h3>
          <span className="text-muted">查看缩略图只切换预览；AI 使用标星的主样张。</span>
        </div>
        <div>
          <button className="btn" onClick={onAdd} disabled={busy || samples.length >= 5}>
            ＋ 添加样张 {samples.length}/5
          </button>
          <button className="btn" onClick={onValidate} disabled={busy || !samples.length}>
            验证当前效果
          </button>
          <button className="btn" onClick={() => onGuide()} disabled={busy}>
            输入与相机引导
          </button>
        </div>
      </div>
      {!samples.length && (
        <p className="workspace-note">
          添加相机直出照片，并确认每张照片的输入基准。统计验证不会发送给模型。
        </p>
      )}
      <div className="sample-strip">
        {samples.map((sample) => (
          <SampleCard
            key={`${sample.id}:${sample.input_contract?.base_photo_style}`}
            sample={sample}
            media={media.get(sample.id)}
            selected={sample.id === selectedId}
            primary={sample.id === primaryId}
            result={
              !stale
                ? validation?.results?.find((r) => r.id === sample.id || r.sample_id === sample.id)
                : null
            }
            busy={busy}
            onSelect={() => onSelect(sample.id)}
            onPrimary={() => onPrimary(sample.id)}
            onRemove={() => onRemove(sample.id)}
            onConfirm={(c) => onConfirm(sample.id, c)}
            onRebind={() => onRebind(sample.id)}
            onGuide={() => onGuide(sample)}
          />
        ))}
      </div>
      {validation && (
        <details className="validation-details">
          <summary>{stale ? '参数或样张已变化，上次验证仅供回看' : '查看统计验证详情'}</summary>
          <pre>{JSON.stringify(validation.results, null, 2)}</pre>
        </details>
      )}
      <label className="preview-cache-option">
        <input
          type="checkbox"
          checked={retainPreviews}
          onChange={(e) => onRetain(e.target.checked)}
          disabled={busy}
        />
        在本机保留缩小预览（最多 24MB，7 天后过期；不保留原文件）
      </label>
    </section>
  )
}
