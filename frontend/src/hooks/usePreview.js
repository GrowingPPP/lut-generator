// LUT 实时预览:管理 WebGL 渲染器的生命周期与图片切换。
//
// 从 App.jsx 抽出来的原因:它是纯粹的命令式副作用逻辑(GL 资源、rAF 合并、
// 对象 URL 回收),与 React 状态编排是两件事,混在一起会互相干扰可读性。
import { useCallback, useEffect, useRef } from 'react'

import { generateLUT } from '../lib/lutEngine.js'
import { LUTRenderer } from '../lib/lutPreview.js'
import { makeTestImage } from '../lib/preview.js'

export default function usePreview(originalRef, gradedRef, params, displayMode) {
  const rendererRef = useRef(null)
  const imageRef = useRef(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  const drawOriginal = useCallback(
    (img) => {
      const oc = originalRef.current
      if (!oc) return
      oc.width = img.width
      oc.height = img.height
      oc.getContext('2d').drawImage(img, 0, 0)
    },
    [originalRef],
  )

  // 初始化默认样张(仅一次)
  useEffect(() => {
    imageRef.current = makeTestImage()
  }, [])

  // 重建 renderer:挂载 + 展示形式切换(canvas 会重挂载)
  useEffect(() => {
    const img = imageRef.current
    const canvas = gradedRef.current
    if (!img || !canvas) return
    const renderer = new LUTRenderer(canvas)
    renderer.setImage(img)
    renderer.setSplitMode(displayMode === 'slider')
    const { data, size } = generateLUT(paramsRef.current, 33)
    renderer.setLUT(data, size)
    renderer.render()
    rendererRef.current = renderer
    drawOriginal(img)
    return () => {
      renderer.dispose()
      rendererRef.current = null
    }
  }, [displayMode, gradedRef, drawOriginal])

  // 参数变化 → 重新生成 LUT(rAF 合并,拖滑杆同一帧只烘一次)
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const id = requestAnimationFrame(() => {
      const { data, size } = generateLUT(paramsRef.current, 33)
      renderer.setLUT(data, size)
      renderer.render()
    })
    return () => cancelAnimationFrame(id)
  }, [params])

  const setSplit = useCallback((x) => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.setSplit(x)
    renderer.render()
  }, [])

  const upload = useCallback(
    (file) =>
      new Promise((resolve) => {
        const url = URL.createObjectURL(file)
        const img = new Image()
        img.onload = () => {
          const side = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight))
          const preview = document.createElement('canvas')
          preview.width = Math.max(1, Math.round(img.naturalWidth * side))
          preview.height = Math.max(1, Math.round(img.naturalHeight * side))
          preview.getContext('2d').drawImage(img, 0, 0, preview.width, preview.height)
          imageRef.current = preview
          drawOriginal(preview)
          const renderer = rendererRef.current
          renderer.setImage(preview)
          const { data, size } = generateLUT(paramsRef.current, 33)
          renderer.setLUT(data, size)
          renderer.render()
          URL.revokeObjectURL(url)
          resolve(true)
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          resolve(false)
        }
        img.src = url
      }),
    [drawOriginal],
  )

  return { setSplit, upload }
}

// 折叠状态下显示「已改动几项」,避免参数被藏起来后用户找不到自己调过什么
