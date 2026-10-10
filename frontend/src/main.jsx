import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './App.css'
import { initializeTheme } from './lib/theme.js'
import { DialogProvider } from './components/ui/Dialog.jsx'
import { TooltipProvider } from './components/ui/Tooltip.jsx'
import './components/ui/UIFoundation.css'

initializeTheme()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <TooltipProvider>
      <DialogProvider><App /></DialogProvider>
    </TooltipProvider>
  </React.StrictMode>,
)
