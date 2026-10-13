import GenerateViewUrl from './GenerateView.jsx?lazy-url'
import LibraryViewUrl from './components/LibraryView.jsx?lazy-url'
import { DialogProvider } from './components/ui/Dialog.jsx'
import { TooltipProvider } from './components/ui/Tooltip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import { DeferredFeature, lazyFeature } from './components/FeatureLoader.jsx'
import './StudioView.css'

const GenerateView = lazyFeature(() => import('./GenerateView.jsx'), '调色项目', GenerateViewUrl)
const LibraryView = lazyFeature(() => import('./components/LibraryView.jsx'), '我的 LUT', LibraryViewUrl)

export default function StudioView({ view, onViewChange, user, previewLut, deletedAssetId,
  onPreview, onDeleted, onLogout }) {
  return <TooltipProvider><DialogProvider>
    <div className="app studio-shell">
      <header className="topbar">
        <button type="button" className="brand studio-brand" aria-label="CHROMA 首页" onClick={() => onViewChange('landing')}><span className="logo">C</span>CHROMA</button>
        <nav className="nav" aria-label="主导航">
          <button className="nav-home" onClick={() => onViewChange('landing')}>首页</button>
          <button className={view === 'generate' ? 'active' : ''} aria-current={view === 'generate' ? 'page' : undefined} onClick={() => onViewChange('generate')}>创作</button>
          <button className={view === 'library' ? 'active' : ''} aria-current={view === 'library' ? 'page' : undefined} onClick={() => onViewChange('library')}>我的 LUT</button>
        </nav>
        <div className="topbar-user"><ThemePicker /><span className="studio-username" title={user}>{user}</span>
          <button className="btn btn-ghost" onClick={onLogout}>退出</button>
        </div>
      </header>
      <main className="studio-page">
        <div hidden={view !== 'generate'}>
          <DeferredFeature active={view === 'generate'}>
            <GenerateView user={user} previewLut={previewLut} deletedAssetId={deletedAssetId} />
          </DeferredFeature>
        </div>
        {view === 'library' && <LibraryView onPreview={onPreview} onDeleted={onDeleted} onCreate={() => onViewChange('generate')} />}
      </main>
    </div>
  </DialogProvider></TooltipProvider>
}
