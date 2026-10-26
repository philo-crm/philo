import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { registerServiceWorker } from './sw-register.ts'
import { applyTheme, readTheme } from './theme.ts'
import './index.css'

// Before the first paint, so a dark choice never flashes light on load.
applyTheme(readTheme())

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerServiceWorker()
