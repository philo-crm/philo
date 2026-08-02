import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const SERVICE_WORKER_SOURCE = fileURLToPath(new URL('./src/sw.js', import.meta.url))

/** Stands in for the build hash inside src/sw.js until this plugin fills it in. */
const BUILD_TOKEN = '__PHILO_BUILD__'

/**
 * Emits src/sw.js at /sw.js — a stable URL, so it cannot be a hashed bundle
 * entry — with its cache name stamped from a hash of this build. Nothing in the
 * worker is bundled or transpiled; it ships as written, which is the point of
 * keeping it small enough to read.
 */
function serviceWorker(): Plugin {
  return {
    name: 'philo:service-worker',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const source = await readFile(SERVICE_WORKER_SOURCE, 'utf8')
      // Silently shipping every deploy under one cache name is exactly the bug
      // a versioned cache exists to prevent, so a rename fails the build.
      if (!source.includes(BUILD_TOKEN)) {
        this.error(`${SERVICE_WORKER_SOURCE} no longer contains ${BUILD_TOKEN}`)
      }
      // Asset filenames are content-hashed, so this changes whenever the app
      // does; the worker's own source is folded in so editing it also counts.
      const build = createHash('sha256')
        .update(source)
        .update(Object.keys(bundle).toSorted().join('\n'))
        .digest('hex')
        .slice(0, 12)
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: source.replaceAll(BUILD_TOKEN, build),
      })
    },
  }
}

// The PWA is served statically by the Hono server, so it builds straight into
// the server's public directory.
export default defineConfig({
  plugins: [react(), serviceWorker()],
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
