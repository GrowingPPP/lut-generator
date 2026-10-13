import StyleSaveDialog from './StyleSaveDialog.jsx'
import ActionMenu from './ui/ActionMenu.jsx'
import ActionIcon from './ui/ActionIcon.jsx'

export default function CreationDelivery({ workspace, image, compatible, media, sample, savedAsset,
  disabled, resourceError, onSave, onBusyChange, onBind, onDownload, onPhotoExport, photoExportEntryRef, onGuide }) {
  const photoAvailable = compatible && !!media?.file && !resourceError
  return <section className="creation-delivery creation-side-section">
    <StyleSaveDialog key={workspace.id} inline workspace={workspace} image={image} compatible={compatible}
      disabled={disabled} onSave={onSave} onBusyChange={onBusyChange} savedAsset={savedAsset} />
    {savedAsset && <p className="creation-confirmed" role="status"><ActionIcon name="check" />已保存到账号：{savedAsset.name}。后续修改只改变草稿，再保存时可选择新作品或更新修订。</p>}
    <section className="creation-downloads" aria-labelledby="creation-download-title">
      <h3 id="creation-download-title">下载到电脑</h3>
      <p className="tool-note">照片与 .cube 下载独立于账号作品保存。</p>
      <button type="button" ref={photoExportEntryRef} className="btn btn-soft" disabled={disabled || !photoAvailable} onClick={onPhotoExport}><ActionIcon name="image" />导出调整后照片 · JPEG / PNG</button>
      {!photoAvailable && <div className="creation-rebind"><p>{resourceError ? `外部 LUT 资源需要重新载入：${resourceError}` : !sample ? '请选择真实照片并确认输入，才能导出照片。LUT 创作与保存仍可进行。' : !media?.file ? '原尺寸照片导出需要电脑上的原文件，缩小预览不能代替原文件。' : '请先确认照片输入，并与当前 LUT 输入基准匹配。'}</p>
        {!resourceError && <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onBind}>{sample && !media?.file ? '重新绑定原文件' : '检查照片与输入'}</button>}
      </div>}
      <ActionMenu label="下载 LUT 文件" disabled={disabled || !!resourceError}
        trigger={<button type="button" className="btn btn-ghost" disabled={disabled || !!resourceError}>下载 .cube LUT <span aria-hidden="true">⌄</span></button>}
        items={[
          { id: 'camera', label: '机内 LUT', description: '用于相机导入，包含当前完整效果', onSelect: () => onDownload('camera') },
          { id: 'software', label: '后期 LUT', description: '用于后期软件，包含当前完整效果', onSelect: () => onDownload('software') },
          { id: 'guide', label: '输入与相机导入说明', separator: true, onSelect: onGuide },
        ]} />
    </section>
  </section>
}
