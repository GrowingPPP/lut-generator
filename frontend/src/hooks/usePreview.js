// LUT 实时预览:管理 WebGL 渲染器的生命周期与图片切换。
//
// 从 App.jsx 抽出来的原因:它是纯粹的命令式副作用逻辑(GL 资源、rAF 合并、
// 对象 URL 回收),与 React 状态编排是两件事,混在一起会互相干扰可读性。
import { useCallback, useEffect, useRef, useState } from 'react'

import { generateLUT } from '../lib/lutEngine.js'
import { LUTRenderer } from '../lib/lutPreview.js'
import { makeTestImage } from '../lib/preview.js'
import { preloadExternalLut } from '../lib/importedLuts.js'

export default function usePreview(
  originalRef,
  gradedRef,
  params,
  displayMode,
  sourceImage,
  enabled = true,
) {
  const rendererRef = useRef(null)
  const imageRef = useRef(null)
  const splitRef = useRef(0.5)
  const readyRef = useRef(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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
    const img = sourceImage || imageRef.current
    const canvas = gradedRef.current
    if (!img || !canvas || !enabled) return
    let renderer
    try {
      renderer = new LUTRenderer(canvas)
      renderer.setImage(img)
      renderer.setSplitMode(displayMode === 'slider')
      renderer.setSplit(splitRef.current)
      renderer.clear()
      rendererRef.current = renderer
      drawOriginal(img)
      setError('')
    } catch (failure) { setError(failure.message); renderer?.dispose(); setLoading(false) }
    return () => {
      renderer?.dispose()
      if (rendererRef.current === renderer) { rendererRef.current = null; readyRef.current = false }
    }
  }, [displayMode, gradedRef, drawOriginal, sourceImage, enabled])

  // 参数变化 → 重新生成 LUT(rAF 合并,拖滑杆同一帧只烘一次)
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !enabled) { readyRef.current = false; setLoading(false); return }
    let cancelled = false
    readyRef.current = false
    setLoading(true); setError(''); renderer.clear()
    const id = requestAnimationFrame(async () => {
      try {
        await preloadExternalLut(params.external_lut_id)
        if (cancelled || rendererRef.current !== renderer) return
        const { data, size } = generateLUT(params, 33)
        renderer.setLUT(data, size)
        renderer.setDisplayEncoding(params.base_photo_style === 'VLOG' ? 'Rec709' : 'sRGB')
        renderer.setSplit(splitRef.current)
        renderer.render()
        readyRef.current = true
      } catch (failure) {
        if (!cancelled && rendererRef.current === renderer) { renderer.clear(); setError(failure.message) }
      } finally { if (!cancelled && rendererRef.current === renderer) setLoading(false) }
    })
    return () => { cancelled = true; cancelAnimationFrame(id) }
  }, [params, sourceImage, displayMode, enabled])

  const setSplit = useCallback((x) => {
    splitRef.current = x
    const renderer = rendererRef.current
    if (!renderer || !readyRef.current) return
    renderer.setSplit(x)
    renderer.render()
  }, [])

  return { setSplit, error, loading }
}

// 折叠状态下显示「已改动几项」,避免参数被藏起来后用户找不到自己调过什么
