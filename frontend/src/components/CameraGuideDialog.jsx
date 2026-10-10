import { useState } from 'react'
import SelectField from './SelectField.jsx'
import useModalFocus from '../hooks/useModalFocus.js'
import { cameraFileName, saveTextFile } from '../lib/api.js'
import {
  CAMERA_GUIDE_SOURCES,
  cameraGuideText,
  cameraInputAdvice,
  identifyCamera,
} from '../lib/cameraGuide.js'
import './CameraGuideDialog.css'

export default function CameraGuideDialog({ params, name, sample, onClose, onDownload }) {
  const modalRef = useModalFocus(onClose)
  const [model, setModel] = useState(identifyCamera(sample?.photo_metadata?.camera_model))
  const filename = cameraFileName(name || 'CHROMA')
  const modelName = { s5ii: 'LUMIX S5II', s5iix: 'LUMIX S5IIX', other: '其他 / 尚未确认' }[model]
  return (
    <div className="modal-backdrop">
      <section
        ref={modalRef}
        className="workspace-modal camera-guide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera-guide-title"
      >
        <div className="section-heading">
          <h2 id="camera-guide-title">输入与相机使用引导</h2>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
        <label>
          参考机型
          <SelectField
            aria-label="相机引导机型"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="s5ii">LUMIX S5II</option>
            <option value="s5iix">LUMIX S5IIX</option>
            <option value="other">其他 / 尚未确认</option>
          </SelectField>
        </label>
        <p className="workspace-note">
          相机信息只用于核对。请手动确认照片拍摄时的 Photo Style；网页无法仅凭 EXIF
          判断直出、后期处理或输入风格。
        </p>
        <dl className="camera-contract">
          <div>
            <dt>当前输入</dt>
            <dd>
              {params.base_photo_style === 'VLOG'
                ? 'V-Log / V-Gamut'
                : `${params.base_photo_style} / sRGB`}
            </dd>
          </div>
          <div>
            <dt>LUT 输出</dt>
            <dd>{params.base_photo_style === 'VLOG' ? 'Rec.709' : 'sRGB'}</dd>
          </div>
          <div>
            <dt>机内文件</dt>
            <dd>{filename}</dd>
          </div>
          <div>
            <dt>导出格式</dt>
            <dd>33 点 · full range · .cube</dd>
          </div>
        </dl>
        <h3>制作前确认输入</h3>
        <p>
          STD、NAT、VIVD 使用对应基础 Photo Style 的 sRGB 直出样张。VLOG 使用未经显示转换的
          V-Log/V-Gamut 帧；普通 JPEG 的低对比外观不能证明它是 V-Log。
        </p>
        <p>{cameraInputAdvice(params.base_photo_style)}</p>
        <h3>{model === 'other' ? '先核对对应机型说明书' : `${modelName} 导入参考`}</h3>
        {model === 'other' && (
          <p className="workspace-note">
            下面为 S5II / S5IIX 的存储卡导入参考。其他机型先确认支持的 LUT 格式、点数和 Photo
            Style，菜单位置以该机型与固件说明书为准。
          </p>
        )}
        <ol>
          <li>
            下载机内版 .cube，放到存储卡根目录。FAT32 文件名最多 8
            位英文字母或数字；本项目导出名满足此限制。
          </li>
          <li>在相机打开 LUT Library，选择空注册位置，再选 Load、存储卡与文件。</li>
          <li>
            {params.base_photo_style === 'VLOG'
              ? '选择使用 V-Log 输入的 Real Time LUT，并指定该 LUT。'
              : `在 My Photo Style 选择 ${params.base_photo_style} 基础风格，并指定该 LUT。`}
            分别核对照片与视频模式，按对应固件菜单操作。
          </li>
        </ol>
        <details>
          <summary>文件不显示、偏色或画面异常时</summary>
          <ul>
            <li>文件不显示：检查 .cube 扩展名、根目录、文件名、存储卡和点数；不要改名为 .vlt。</li>
            <li>
              发灰或偏色：核对基础 Photo Style、输入编码、LUT
              强度和额外调色设置，排除重复的显示转换。
            </li>
            <li>
              变黑或过曝：核对曝光与白平衡，对照未加载 LUT 的画面；原图丢失的细节无法由 LUT 恢复。
            </li>
          </ul>
        </details>
        <p className="camera-sources">
          依据{' '}
          <a href={CAMERA_GUIDE_SOURCES.library} target="_blank" rel="noreferrer">
            官方 LUT Library 说明书
          </a>{' '}
          与{' '}
          <a href={CAMERA_GUIDE_SOURCES.usage} target="_blank" rel="noreferrer">
            Photo Style 使用指南
          </a>
          。固件不同可能改变菜单与头信息支持，请核对{' '}
          <a href={CAMERA_GUIDE_SOURCES.support} target="_blank" rel="noreferrer">
            型号与固件资料
          </a>
          。
        </p>
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() =>
              saveTextFile(
                cameraGuideText({ params, filename, model: modelName }),
                `${filename.slice(0, -5)}_guide.txt`,
              )
            }
          >
            下载当前使用说明
          </button>
          <button className="btn-primary" onClick={onDownload}>
            下载当前机内版
          </button>
        </div>
      </section>
    </div>
  )
}
