export const CREATION_STEPS = [
  { id: 'photos', title: '选照片', hint: '建立创作起点', heading: '从一张照片，开始创作', description: '确认拍摄时的照片风格，让预览和调整有可靠的起点。' },
  { id: 'style', title: '定风格', hint: '表达你的想法', heading: '为照片，找到你的色彩', description: '描述想要的变化、优化照片，或从参考图出发。也可以直接进入手动调整。' },
  { id: 'adjust', title: '调效果', hint: '比较与精细调整', heading: '让细节，更接近你的想法', description: '对比原图和当前效果，从基础参数开始，再按需打开高级工具。' },
  { id: 'save', title: '保存作品', hint: '留住你的色彩', heading: '保存这次创作', description: '保存到我的 LUT，或将当前效果下载为照片与 LUT 文件。' },
]

export function isCreationStep(value) {
  return CREATION_STEPS.some(step => step.id === value)
}

// Viewing a step never certifies inputs or changes formal grading state.
export function restoredCreationStep(workspace) {
  const view = workspace.view_state || {}
  if (isCreationStep(view.creation_step)) return view.creation_step
  if (workspace.report || ['manual', 'versions'].includes(view.tool_tab)) return 'adjust'
  return workspace.samples?.length ? 'style' : 'photos'
}

export function creationToolTab(step, tab) {
  if (step === 'style') return 'ai'
  if (step === 'adjust') return tab === 'versions' ? 'versions' : 'manual'
  return 'none'
}
