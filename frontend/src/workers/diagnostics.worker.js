import { measureDiagnostics } from '../lib/diagnostics.js'
import { registerExternalLut } from '../lib/importedLuts.js'

self.onmessage = ({ data: { id, image, params, external } }) => {
  try {
    if (params.external_lut_id) registerExternalLut(params.external_lut_id, external)
    const result = measureDiagnostics(image, params)
    self.postMessage({ id, result }, [result.current_pixels.buffer, result.overlay_pixels.buffer])
  } catch (error) {
    self.postMessage({ id, error: error.message || '无法测量当前预览' })
  }
}
