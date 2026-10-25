import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Tests live beside the server's, in a `test/` directory rather than next to
// the source, so `vite build` never has to be told to exclude them.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    // The fake API replaces `fetch`; without this it would leak into the next file.
    unstubGlobals: true,
  },
})
