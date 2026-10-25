import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { SDK_SOURCE } from './vite.config.ts'

// Tests live beside the server's, in a `test/` directory rather than next to
// the source, so `vite build` never has to be told to exclude them.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@philo/sdk': SDK_SOURCE } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    // The fake API replaces `fetch`; without this it would leak into the next file.
    unstubGlobals: true,
  },
})
