import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { generateLUT } from '../lib/lutEngine.js'
import { LUTRenderer } from '../lib/lutPreview.js'
import { compareVersionParams, compatibleVersionInputs } from '../lib/versionComparison.js'
import './ComparisonPreview.css'

function RenderedImage({ image, params, label, className = '' }) {
  const canvas = useRef(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!image) return
    let renderer
    try {
      renderer = new LUTRenderer(canvas.current)
      renderer.setImage(image)
      renderer.setSplitMode(false)
      const { data, size } = generateLUT(params, 33)
      renderer.setLUT(data, size)
      renderer.render()
      setError('')
    } catch (e) {
      setError(e.message)
    }
    return () => renderer?.dispose()
  }, [image, params])
  return (
    <div className={`pane ${className}`}>
      <div className="pane-label" title={label}>{label}</div>
      {error && <p className="error">{error}</p>}
      <canvas ref={canvas} className="pane-canvas" role="img" aria-label={label} />
    </div>
  )
}

export default function ComparisonPreview({ image, a, b, compatible }) {
  const [split, setSplit] = useState(50)
  const comparisonId = useId()
  const differences = useMemo(() => a && b ? compareVersionParams(a.params, b.params) : null, [a?.params, b?.params])
  if (!a || !b)
    return (
      <div className="preview-empty">选择两个版本进行比较，或把当前草稿固定为一份比较快照。</div>
    )
  const inputsMatch = compatibleVersionInputs(a.params, b.params)
  const canPreview = inputsMatch && image && compatible
  const unavailable = !inputsMatch
    ? '两版输入基准或输出编码不同，暂不比较图像。下方仍显示完整参数差异。'
    : '请选择已确认且与两版输入基准一致的样张。下方仍显示完整参数差异。'
  return (
    <section className="comparison-preview" aria-label="版本 A/B 比较">
      <div className="comparison-heading">
        <h3>版本比较</h3>
        <p><strong>A · {a.name || '未命名版本'}</strong><span>与</span><strong>B · {b.name || '未命名版本'}</strong></p>
      </div>
      {canPreview && a.params.tone_map !== b.params.tone_map && (
        <p className="workspace-note">两版使用不同的显示映射；差异已包含在预览中。</p>
      )}
      {canPreview ? (
        <>
          <div className="comparison-visual" style={{ '--comparison-ratio': `${image.width} / ${image.height}`, '--comparison-split': `${split}%` }}>
            <RenderedImage image={image} params={a.params} label={`A · ${a.name || '未命名版本'}`} className="comparison-layer comparison-a" />
            <RenderedImage image={image} params={b.params} label={`B · ${b.name || '未命名版本'}`} className="comparison-layer comparison-b" />
            <div className="comparison-divider" aria-hidden="true"><span>↔</span></div>
          </div>
          <div className="comparison-slide-control">
            <label htmlFor={`${comparisonId}-split`}>滑动比较 A / B</label>
            <input id={`${comparisonId}-split`} type="range" min="0" max="100" step="1" value={split}
              onChange={(event) => setSplit(Number(event.target.value))}
              aria-valuetext={`左侧 A ${split}%，右侧 B ${100 - split}%`} />
            <div className="comparison-slide-labels"><span>A · {a.name || '未命名版本'}</span><span>B · {b.name || '未命名版本'}</span></div>
          </div>
          <p className="text-muted">两版使用同一张样张和同一缩放比例。</p>
        </>
      ) : <div className="preview-empty">{unavailable}</div>}
      <div className="comparison-differences">
        <h4>参数差异 <span>（B − A）</span></h4>
        {differences.identical ? (
          <p className="comparison-identical" role="status">两版全部 30 项参数相同，没有参数差异。</p>
        ) : (
          <>
            <p className="text-muted">共 {differences.changedCount} 项变化，按参数组列出。</p>
            {differences.groups.map((group) => (
              <section className="comparison-diff-group" key={group.id} aria-labelledby={`${comparisonId}-${group.id}`}>
                <h5 id={`${comparisonId}-${group.id}`}>{group.label}</h5>
                <table>
                  <thead><tr><th scope="col">参数</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead>
                  <tbody>{group.rows.map((row) => (
                    <tr key={row.field}>
                      <th scope="row">{row.label}</th>
                      <td>{row.beforeText}</td><td>{row.afterText}</td><td>{row.deltaText}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </section>
            ))}
          </>
        )}
      </div>
      <p className="text-muted">比较使用选中时固定的参数快照；更新比较快照可重新固定当前草稿。</p>
    </section>
  )
}

export { RenderedImage }
