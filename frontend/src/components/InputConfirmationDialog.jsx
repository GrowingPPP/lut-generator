import { defaultParams } from '../lib/lutEngine.js'
import { applyStyleRecipe, inputContract } from '../lib/styleRecipe.js'
import { RenderedImage } from './ComparisonPreview.jsx'
import { ModalSurface } from './ui/Dialog.jsx'

export default function InputConfirmationDialog({ workspace, image, onConfirm, onClose }) {
  const neutral = {
    ...defaultParams(),
    base_photo_style: workspace.params.base_photo_style,
    tone_map: workspace.params.tone_map,
  }
  const recipe = {
    format_version: 1,
    operations: workspace.recipe_projection.operations,
    kind: 'portable_style',
    input_contract: inputContract(neutral),
  }
  let candidate, error
  try {
    candidate = Object.keys(recipe.operations).length ? applyStyleRecipe(recipe, neutral) : neutral
  } catch (e) {
    error = e.message
  }
  return (
    <ModalSurface onClose={onClose}>
      <section
        className="workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-label="确认配方的新输入"
      >
        <h2>复核新输入下的风格</h2>
        <p className="workspace-note">
          以下候选使用 {neutral.base_photo_style}{' '}
          输入与当前显示映射，在中性校正上生成风格。确认后才更新配方的输入契约；确认前保留原契约。
        </p>
        {error && <p className="error">{error}</p>}
        {candidate && image && (
          <RenderedImage image={image} params={candidate} label="新输入风格候选" />
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={onConfirm} disabled={!candidate || !image}>
            确认配方的新输入
          </button>
        </div>
      </section>
    </ModalSurface>
  )
}
