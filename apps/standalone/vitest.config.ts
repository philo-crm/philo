import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  // Every workspace from source: this app is composition, and testing it
  // against stale builds would test nothing.
  resolve: {
    alias: {
      '@philo/sdk': source('../../packages/sdk/src/index.ts'),
      '@philo/server': source('../../packages/server/src/boot.ts'),
      '@philo/mcp': source('../mcp/src/app.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
