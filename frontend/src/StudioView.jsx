import GenerateViewUrl from './GenerateView.jsx?lazy-url'
import LibraryViewUrl from './components/LibraryView.jsx?lazy-url'
import { DialogProvider } from './components/ui/Dialog.jsx'
import { TooltipProvider } from './components/ui/Tooltip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import { DeferredFeature, lazyFeature } from './components/FeatureLoader.jsx'

const GenerateView = lazyFeature(() => import('./GenerateView.jsx'), '调色工作区', GenerateViewUrl)
const LibraryView = lazyFeature(() => import('./components/LibraryView.jsx'), '我的 LUT', LibraryViewUrl)

export default function StudioView({ view, onViewChange, user, previewLut, deletedAssetId,
  onPreview, onDeleted, onLogout }) {
  return <TooltipProvider><DialogProvider>
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">C</span>CHROMA</div>
        <nav className="nav">
          <button className="nav-home" onClick={() => onViewChange('landing')}>首页</button>
          <button className={view === 'generate' ? 'active' : ''} onClick={() => onViewChange('generate')}>生成</button>
          <button className={view === 'library' ? 'active' : ''} onClick={() => onViewChange('library')}>我的 LUT</button>
        </nav>
        <div className="topbar-user"><ThemePicker /><span>{user}</span>
          <button className="btn" onClick={onLogout}>退出</button>
        </div>
      </header>
      <div hidden={view !== 'generate'}>
        <DeferredFeature active={view === 'generate'}>
          <GenerateView user={user} previewLut={previewLut} deletedAssetId={deletedAssetId} />
        </DeferredFeature>
      </div>
      {view === 'library' && <LibraryView onPreview={onPreview} onDeleted={onDeleted} />}
    </div>
  </DialogProvider></TooltipProvider>
}
