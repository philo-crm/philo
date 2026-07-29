import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The PWA is served statically by the Hono server, so it builds straight into
// the server's public directory.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/version': 'http://localhost:3000',
    },
  },
})
