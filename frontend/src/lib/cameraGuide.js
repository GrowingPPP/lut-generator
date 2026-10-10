export const CAMERA_GUIDE_SOURCES = {
  library: 'https://eww.pavc.panasonic.co.jp/dscoi/DC-S5M2X/html/DC-S5M2X_DVQP2992_eng/0072.html',
  usage:
    'https://www.panasonic.com/uk/consumer/cameras-camcorders/lumix-expert-advice-learn/lumix-expert-advice/using-real-time-luts.html',
  support: 'https://av.jpn.support.panasonic.com/support/global/cs/dsc/',
}

export function identifyCamera(model = '') {
  if (/S5M2X|S5IIX/i.test(model)) return 's5iix'
  if (/S5M2|S5II/i.test(model)) return 's5ii'
  return 'other'
}

export function cameraInputAdvice(style) {
  return style === 'VLOG'
    ? '使用未经显示转换的 V-Log/V-Gamut 输入。LUT 已包含到 Rec.709 的映射，使用时不要再串联同类转换 LUT。'
    : `在 My Photo Style 中选择 ${style} 基础 Photo Style，再启用本 LUT。相机输入需与制作时的直出样张一致。`
}

export function cameraGuideText({ params, filename, model }) {
  return [
    'CHROMA 当前 LUT 使用说明',
    `机型：${model || '尚未确认'}`,
    `相机文件：${filename}`,
    '格式：33 点 full-range 3D .cube',
    `输入：${params.base_photo_style === 'VLOG' ? 'V-Log / V-Gamut' : `${params.base_photo_style} / sRGB`}`,
    `输出：${params.base_photo_style === 'VLOG' ? 'Rec.709' : 'sRGB'}`,
    `显示映射强度：${params.tone_map}`,
    cameraInputAdvice(params.base_photo_style),
    '',
    'S5II / S5IIX 导入参考：',
    '将 .cube 放入存储卡根目录；FAT32 使用最多 8 位英文字母或数字的文件名。',
    '打开 LUT Library，选择空注册位置，Load 后选择存储卡及文件。',
    '检查基础 Photo Style 与 LUT 选择，并分别核对照片/视频设置。',
    '机型或固件菜单不同，请按对应官方说明书操作；其他机型需先确认 LUT 支持。',
    '',
    '异常排查：',
    '文件不显示：检查扩展名、根目录、文件名、存储卡与 3D LUT 点数；不要把 .cube 改名为 .vlt。',
    '图像发灰或偏色：核对输入 Photo Style、sRGB/V-Log 编码、是否重复转换、相机 LUT 强度和额外调色项。',
    '画面变黑或过曝：核对曝光、白平衡与基础 Photo Style，再降低调色强度对照；原图已丢失的细节无法通过 LUT 恢复。',
    '本说明是导入引导；真实模型效果与相机实拍验收尚待执行。',
    '',
    `LUT Library：${CAMERA_GUIDE_SOURCES.library}`,
    `Photo Style 使用指南：${CAMERA_GUIDE_SOURCES.usage}`,
    `机型/固件支持：${CAMERA_GUIDE_SOURCES.support}`,
  ].join('\n')
}
