import { measureDiagnostics } from '../lib/diagnostics.js'

self.onmessage = ({ data: { id, image, params } }) => {
  try {
    const result = measureDiagnostics(image, params)
    self.postMessage({ id, result }, [result.current_pixels.buffer, result.overlay_pixels.buffer])
  } catch (error) {
    self.postMessage({ id, error: error.message || '无法测量当前预览' })
  }
}
