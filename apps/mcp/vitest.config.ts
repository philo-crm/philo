import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The SDK from source, as in apps/web: a change to it is tested here without
  // a build in between.
  resolve: {
    alias: { '@philo/sdk': fileURLToPath(new URL('../../packages/sdk/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
