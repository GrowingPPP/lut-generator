import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import ParameterPanel from './ParameterPanel.jsx'
import CurveEditor from './CurveEditor.jsx'
import ParameterHelp from './ParameterHelp.jsx'
import RangeField, { NumberField } from './ui/RangeField.jsx'
import ProtectionButton from './ui/ProtectionButton.jsx'
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from './ui/Tabs.jsx'

const SAVE_STATES = {
  loading: '正在恢复草稿', saving: '草稿保存中', saved: '草稿已保存到本机',
  unsaved: '当前修改未保存', conflict: '另一标签页已更新草稿',
}
const EXTERNAL_FIELDS = ['external_lut_id', 'external_lut_strength', 'external_lut_mode']

const PhotoAdjustments = forwardRef(function PhotoAdjustments({ editor, disabled, gesture, onUpdateParam, onUpdateChannel, onToggleLock, resourceError,
  allParameters, onPresentationChange, groupOpen, onGroupOpen }, ref) {
  const { workspace, saveStatus, error, conflict } = editor
  const { params, locked_fields: locked } = workspace
  const [tab, setTab] = useState('parameters')
  const [feedback, setFeedback] = useState('')
  const curveRef = useRef(null)
  const externalProtectedCount = EXTERNAL_FIELDS.filter(field => locked.includes(field)).length
  const externalLocked = externalProtectedCount > 0
  const externalFullyLocked = externalProtectedCount === EXTERNAL_FIELDS.length
  const finishPendingEdit = () => { curveRef.current?.finishPendingEdit(); return editor.commit() }
  useImperativeHandle(ref, () => ({ finishPendingEdit }))
  const selectTab = next => { finishPendingEdit(); setTab(next) }
  const reset = fields => {
    if (editor.reset(fields)) setFeedback(`已复位未保护项，保留 ${fields.filter(field => locked.includes(field)).length} 项`)
  }
  return <div className="photo-adjustments">
    <p className={`draft-status ${saveStatus}`} role="status">{SAVE_STATES[saveStatus] || saveStatus}</p>
    {(error || conflict || resourceError) && <div className="draft-error" role="alert">
      {error?.message || (conflict ? '另一标签页已更新草稿，请关闭查看器后载入最新内容或另存副本。' : resourceError)}
      {error && !conflict && <button type="button" className="btn btn-soft btn-sm" disabled={disabled} onClick={editor.flush}>重试保存</button>}
      {resourceError && <p>请关闭查看器后，在外部 LUT 区域重新选择并载入资源。</p>}
    </div>}
    <TabsRoot value={tab} onValueChange={selectTab}>
    <TabsList className="photo-adjustment-tabs" aria-label="放大调色工具">
      <TabsTrigger value="parameters">参数调整</TabsTrigger>
      <TabsTrigger value="curves">自由曲线</TabsTrigger>
    </TabsList>
    <TabsContent value="parameters" forceMount asChild>
    <div>
    <ParameterPanel allParameters={allParameters} onPresentationChange={value => { finishPendingEdit(); onPresentationChange?.(value) }}
      groupOpen={groupOpen} onGroupOpen={onGroupOpen} params={params} lockedFields={locked} disabled={disabled} gesture={gesture} contextKey={workspace.id}
        onUpdateParam={onUpdateParam} onUpdateChannel={onUpdateChannel} onToggleLock={onToggleLock}
        onSetLocks={editor.setLocks} onReset={reset}>
      {params.external_lut_id && <section className="param-group photo-adjustment-external">
        <div className="param-group-header parameter-effect-heading"><strong className="param-group-label">外部 LUT</strong>
          <ProtectionButton label="外部 LUT" locked={externalFullyLocked} mixed={externalLocked && !externalFullyLocked}
            compact={false} disabled={disabled}
            onClick={() => externalFullyLocked
              ? editor.setLocks(locked.filter(field => !EXTERNAL_FIELDS.includes(field))) : onToggleLock(EXTERNAL_FIELDS)} />
        </div>
        <div className="controls"><div className="slider">
          <span>叠加强度</span><RangeField min="0" max="1" step="0.01" value={params.external_lut_strength}
            aria-label="外部 LUT 叠加强度" disabled={disabled || externalLocked || params.external_lut_mode === 'input'}
            {...gesture} onChange={event => onUpdateParam('external_lut_strength', Number(event.target.value))} />
          <NumberField aria-label="外部 LUT 叠加强度 数值" min={0} max={100} step={1}
            value={Math.round(params.external_lut_strength * 100)} unit="%" disabled={disabled || externalLocked || params.external_lut_mode === 'input'}
            {...gesture} onChange={event => onUpdateParam('external_lut_strength', Number(event.target.value) / 100)} />
        </div></div>
        <div className="photo-adjustment-external-help"><ParameterHelp parameter="external_lut_strength" /></div>
        {params.external_lut_mode === 'input' && <p className="tool-note">输入转换 LUT 强度固定为 100%。</p>}
      </section>}
    </ParameterPanel>
    </div>
    </TabsContent>
    <TabsContent value="curves" forceMount asChild>
    <div className="photo-adjustment-curves">
      <div className="parameter-effect-heading">
        <div><h3>自由曲线</h3><span className="tool-note">四通道独立调整</span></div>
        <ProtectionButton label="自由曲线" locked={locked.includes('curve_points')} compact={false} disabled={disabled}
          onClick={() => { finishPendingEdit(); onToggleLock(['curve_points']) }} />
      </div>
      <CurveEditor ref={curveRef} showHeading={false} params={params} disabled={disabled || tab !== 'curves'} locked={locked}
        onBegin={() => editor.begin({ source: 'curve', purpose: 'style' })} onPreview={editor.update}
        onCommit={patch => editor.commit(patch, { source: 'curve', purpose: 'style' })} onCancel={editor.cancel} />
    </div>
    </TabsContent>
    </TabsRoot>
    {feedback && <p className="tool-note" role="status">{feedback}</p>}
  </div>
})

export default PhotoAdjustments
