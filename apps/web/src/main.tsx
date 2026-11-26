import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { postFramedCallback } from './extra-token.ts'
import { registerServiceWorker } from './sw-register.ts'
import { applyTheme, readTheme } from './theme.ts'
import './index.css'

// A hidden extra-token request coming back (extra-token.ts): hand the callback
// to the page that framed it and stop, before App's own callback logic runs.
if (!postFramedCallback()) start()

function start(): void {
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
}
