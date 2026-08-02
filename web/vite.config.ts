import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const SERVICE_WORKER_SOURCE = fileURLToPath(new URL('./src/sw.js', import.meta.url))
const INDEX_HTML = fileURLToPath(new URL('./index.html', import.meta.url))

/** Placeholders src/sw.js carries until the plugin below fills them in. */
const BUILD_TOKEN = '__PHILO_BUILD__'
const PRECACHE_TOKEN = '__PHILO_PRECACHE__'

/**
 * Emits src/sw.js at /sw.js — a stable URL, so it cannot be a hashed bundle
 * entry — with two things stamped in: the list of files that make up this
 * build's app shell, and a hash of that build to name its cache after. Nothing
 * in the worker is bundled or transpiled; it ships as written, which is the
 * point of keeping it small enough to read.
 */
export function serviceWorker(): Plugin {
  return {
    name: 'philo:service-worker',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const source = await readFile(SERVICE_WORKER_SOURCE, 'utf8')
      // Shipping every deploy under one cache name is exactly the bug a
      // versioned cache exists to prevent, so a rename fails the build.
      for (const token of [BUILD_TOKEN, PRECACHE_TOKEN]) {
        if (!source.includes(token)) {
          this.error(`${SERVICE_WORKER_SOURCE} no longer contains ${token}`)
        }
      }

      // The shell is index.html plus the hashed files it pulls in. index.html
      // itself is emitted after this hook runs, so it goes in as '/' — the URL
      // the server answers with it — rather than by filename.
      const precache = [
        '/',
        ...Object.keys(bundle)
          .filter((name) => name.startsWith('assets/'))
          .toSorted()
          .map((name) => `/${name}`),
      ]

      // Asset filenames are content-hashed, so this changes whenever app code
      // does. index.html carries no hash of its own and is not in the bundle
      // yet, so its source is folded in by hand; so is the worker's, to cover
      // an edit that touches nothing else.
      const build = createHash('sha256')
        .update(source)
        .update(await readFile(INDEX_HTML, 'utf8'))
        .update(precache.join('\n'))
        .digest('hex')
        .slice(0, 12)

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: source
          .replaceAll(BUILD_TOKEN, build)
          .replaceAll(PRECACHE_TOKEN, JSON.stringify(precache)),
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
