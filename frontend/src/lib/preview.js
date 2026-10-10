// 预览相关的纯工具:内置合成样张与缩略图。
//
// 抽出来单独放的原因:这两个函数被生成页与「我的 LUT」页共用,
// 之前都堆在 App.jsx 里,导致改一处要读 950 行文件。
import { applyLUTToImageData, generateLUT } from './lutEngine.js'
import { displayImageData } from './displayColor.js'

let _testImage = null

/** 内置合成样张(夕阳海景 + 人像剪影)。仅用于未上传照片时预览 LUT 效果。 */
export function makeTestImage() {
  if (_testImage) return _testImage
  const c = document.createElement('canvas')
  c.width = 800
  c.height = 560
  const ctx = c.getContext('2d')
  const sky = ctx.createLinearGradient(0, 0, 0, 360)
  sky.addColorStop(0, '#3a4a63')
  sky.addColorStop(0.45, '#8a7a6a')
  sky.addColorStop(0.75, '#c89b72')
  sky.addColorStop(1, '#d9a878')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, 800, 360)
  ctx.fillStyle = '#f4d7a4'
  ctx.beginPath()
  ctx.arc(600, 270, 46, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#2e2b31'
  ctx.beginPath()
  ctx.moveTo(0, 360)
  ctx.lineTo(120, 240)
  ctx.lineTo(220, 330)
  ctx.lineTo(340, 210)
  ctx.lineTo(470, 350)
  ctx.lineTo(600, 250)
  ctx.lineTo(720, 340)
  ctx.lineTo(800, 300)
  ctx.lineTo(800, 360)
  ctx.closePath()
  ctx.fill()
  const sea = ctx.createLinearGradient(0, 360, 0, 560)
  sea.addColorStop(0, '#c8996f')
  sea.addColorStop(1, '#4a3a3c')
  ctx.fillStyle = sea
  ctx.fillRect(0, 360, 800, 200)
  _testImage = c
  return c
}

/** 用当前参数在内置样张上渲染一张缩略图(dataURL),供 LUT 列表展示。 */
export function makeThumb(params) {
  const w = 320
  const h = 200
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  ctx.drawImage(makeTestImage(), 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data, size } = generateLUT(params, 33)
  const out = displayImageData(applyLUTToImageData(imageData, data, size), params.base_photo_style)
  ctx.putImageData(out, 0, 0)
  return c.toDataURL('image/jpeg', 0.85)
}
