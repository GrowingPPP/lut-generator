import AuthViewUrl from './components/AuthView.jsx?lazy-url'
import StudioViewUrl from './StudioView.jsx?lazy-url'
import { useEffect, useState } from 'react'
import { logout as apiLogout, me } from './lib/api.js'
import { clearExternalLutCache } from './lib/importedLuts.js'
import LandingView from './LandingView.jsx'
import { FeatureStatus, lazyFeature } from './components/FeatureLoader.jsx'

const AuthView = lazyFeature(() => import('./components/AuthView.jsx'), '登录页面', AuthViewUrl)
const StudioView = lazyFeature(() => import('./StudioView.jsx'), '调色工作台', StudioViewUrl)

export default function App() {
  const [view, setView] = useState('landing')
  const [previewLut, setPreviewLut] = useState(null)
  const [deletedAssetId, setDeletedAssetId] = useState(null)
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  const [studioUser, setStudioUser] = useState(null)

  useEffect(() => {
    const onUnauthorized = () => {
      clearExternalLutCache()
      setUser(null)
      setStudioUser(null)
      setPreviewLut(null)
      setDeletedAssetId(null)
    }
    window.addEventListener('chroma:unauthorized', onUnauthorized)
    return () => window.removeEventListener('chroma:unauthorized', onUnauthorized)
  }, [])

  useEffect(() => {
    me().then(current => setUser(current ? current.username : null))
      .catch(() => setUser(null)).finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    if (user && view !== 'landing') setStudioUser(user)
  }, [user, view])

  const openPreview = lut => {
    setPreviewLut({ ...lut, params: { ...lut.params } })
    setView('generate')
  }
  const handleAssetDeleted = id => {
    setDeletedAssetId(id)
    setPreviewLut(current => current?.id === id ? null : current)
  }
  const handleLogout = async () => {
    clearExternalLutCache()
    try { await apiLogout() } catch { /* Clear the local session even if the request fails. */ }
    setUser(null)
    setStudioUser(null)
    setPreviewLut(null)
    setDeletedAssetId(null)
  }

  return <>
    {view === 'landing' && <LandingView onEnter={() => setView('generate')} />}
    {view !== 'landing' && checking && <FeatureStatus title="登录状态" />}
    {view !== 'landing' && !checking && !user && <AuthView onAuthed={setUser} />}
    {user && (view !== 'landing' || studioUser === user) &&
      <div hidden={view === 'landing'}>
        <StudioView key={user} view={view} onViewChange={setView} user={user}
          previewLut={previewLut} deletedAssetId={deletedAssetId}
          onPreview={openPreview} onDeleted={handleAssetDeleted} onLogout={handleLogout} />
      </div>}
  </>
}
