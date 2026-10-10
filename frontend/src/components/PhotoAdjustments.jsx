import { useState } from 'react'
import ParameterControls from './ParameterControls.jsx'
import CurveEditor from './CurveEditor.jsx'

const SAVE_STATES = {
  loading: '正在恢复草稿', saving: '草稿保存中', saved: '草稿已保存到本机',
  unsaved: '当前修改未保存', conflict: '另一标签页已更新草稿',
}
const EXTERNAL_FIELDS = ['external_lut_id', 'external_lut_strength', 'external_lut_mode']

export default function PhotoAdjustments({ editor, disabled, gesture, onUpdateParam, onUpdateChannel, onToggleLock, resourceError }) {
  const { workspace, saveStatus, error, conflict } = editor
  const { params, locked_fields: locked } = workspace
  const [tab, setTab] = useState('parameters')
  const [feedback, setFeedback] = useState('')
  const externalLocked = EXTERNAL_FIELDS.some(field => locked.includes(field))
  const selectTab = next => { editor.commit(); setTab(next) }
  const reset = fields => {
    if (editor.reset(fields)) setFeedback(`已复位未保护项，保留 ${fields.filter(field => locked.includes(field)).length} 项`)
  }
  return <div className="photo-adjustments">
    <p className={`draft-status ${saveStatus}`} role="status">{SAVE_STATES[saveStatus] || saveStatus}</p>
    {(error || conflict || resourceError) && <div className="draft-error" role="alert">
      {error?.message || (conflict ? '另一标签页已更新草稿，请关闭查看器后载入最新内容或另存副本。' : resourceError)}
      {error && !conflict && <button type="button" className="btn" disabled={disabled} onClick={editor.flush}>重试保存</button>}
      {resourceError && <p>请关闭查看器后，在外部 LUT 区域重新选择并载入资源。</p>}
    </div>}
    <div className="photo-adjustment-tabs" role="group" aria-label="放大调色工具">
      <button type="button" className="photo-viewer-button" aria-pressed={tab === 'parameters'} onClick={() => selectTab('parameters')}>参数调整</button>
      <button type="button" className="photo-viewer-button" aria-pressed={tab === 'curves'} onClick={() => selectTab('curves')}>自由曲线</button>
    </div>
    <fieldset className="params param-groups" disabled={disabled} hidden={tab !== 'parameters'}>
      <ParameterControls params={params} lockedFields={locked} disabled={disabled} gesture={gesture}
        onUpdateParam={onUpdateParam} onUpdateChannel={onUpdateChannel} onToggleLock={onToggleLock}
        onSetLocks={editor.setLocks} onReset={reset} />
      {params.external_lut_id && <section className="param-group photo-adjustment-external">
        <div className="param-group-header"><strong className="param-group-label">外部 LUT</strong>
          <button type="button" className={`parameter-lock ${externalLocked ? 'locked' : ''}`}
            aria-label={`${externalLocked ? '解锁' : '保护'}外部 LUT`} onClick={() => externalLocked
              ? editor.setLocks(locked.filter(field => !EXTERNAL_FIELDS.includes(field))) : onToggleLock(EXTERNAL_FIELDS)}>
            {externalLocked ? '已保护' : '保护'}</button>
        </div>
        <div className="controls"><div className="slider">
          <span>叠加强度</span><input type="range" min="0" max="1" step="0.01" value={params.external_lut_strength}
            aria-label="外部 LUT 叠加强度" disabled={disabled || externalLocked || params.external_lut_mode === 'input'}
            {...gesture} onChange={event => onUpdateParam('external_lut_strength', Number(event.target.value))} />
          <em>{Math.round(params.external_lut_strength * 100)}%</em>
        </div></div>
        {params.external_lut_mode === 'input' && <p className="tool-note">输入转换 LUT 强度固定为 100%。</p>}
      </section>}
    </fieldset>
    <div className="photo-adjustment-curves" hidden={tab !== 'curves'}>
      <button type="button" className={`parameter-lock ${locked.includes('curve_points') ? 'locked' : ''}`} disabled={disabled}
        onClick={() => onToggleLock(['curve_points'])}>{locked.includes('curve_points') ? '解除自由曲线保护' : '保护自由曲线'}</button>
      <CurveEditor params={params} disabled={disabled || tab !== 'curves'} locked={locked}
        onBegin={() => editor.begin({ source: 'curve', purpose: 'style' })} onPreview={editor.update}
        onCommit={patch => editor.commit(patch, { source: 'curve', purpose: 'style' })} onCancel={editor.cancel} />
    </div>
    {feedback && <p className="tool-note" role="status">{feedback}</p>}
  </div>
}
