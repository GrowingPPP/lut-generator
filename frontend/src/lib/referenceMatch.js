import { equalValue } from './styleRecipe.js'

export async function requestReferenceMatch({ file, reference, params, context, workspaceId,
  mainSampleId, sourceDigest, color, tone, strength }) {
  const body = new FormData()
  body.append('file', file)
  body.append('reference', reference)
  body.append('params', JSON.stringify(params))
  body.append('context', JSON.stringify(context))
  body.append('workspace_id', workspaceId)
  body.append('main_sample_id', mainSampleId)
  body.append('source_digest', sourceDigest)
  body.append('color', String(color))
  body.append('tone', String(tone))
  body.append('strength', String(strength))
  const response = await fetch('/api/reference/match', { method: 'POST', credentials: 'include', body })
  if (response.status === 401) window.dispatchEvent(new Event('chroma:unauthorized'))
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || '参考匹配未完成')
  return data
}

export function matchingReferenceResult(result, request) {
  return result?.workspace_id === request.workspaceId
    && result?.main_sample_id === request.mainSampleId
    && result?.source_digest === request.sourceDigest
    && result?.reference_digest === request.referenceDigest
    && equalValue(result?.before_params, request.params)
    && equalValue(result?.context, request.context)
}
