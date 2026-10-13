import { useCallback, useEffect, useRef, useState } from 'react'
import { createCoverStorage } from '../lib/assetCovers.js'

export default function useAssetCovers(user, assets) {
  const storage = useRef(null)
  if (!storage.current) storage.current = createCoverStorage()
  const [urls, setUrls] = useState({})
  const [error, setError] = useState(null)
  const [revision, setRevision] = useState(0)
  const channel = useRef(null)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!user || !globalThis.BroadcastChannel) return
    const connection = new BroadcastChannel(`chroma-covers:${user}`)
    channel.current = connection
    connection.onmessage = refresh
    return () => { connection.close(); channel.current = null }
  }, [user, refresh])
  useEffect(() => {
    let active = true
    const created = []
    setUrls({})
    if (user) void Promise.all(assets.map(async asset => {
      const blob = await storage.current.get(user, asset.id)
      if (!blob || !active) return null
      const url = URL.createObjectURL(blob)
      created.push(url)
      return [asset.id, url]
    })).then(entries => {
      if (active) { setUrls(Object.fromEntries(entries.filter(Boolean))); setError(null) }
    }).catch(failure => { if (active) setError(failure) })
    return () => { active = false; created.forEach(url => URL.revokeObjectURL(url)) }
  }, [user, assets, revision])
  const save = async (id, blob, options) => {
    await storage.current.put(user, id, blob, options)
    channel.current?.postMessage({ assetId: id })
    refresh()
  }
  return { urls, error, save, refresh }
}
