// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build, type Rollup } from 'vite'
import viteConfig, { serviceWorker } from '../vite.config.ts'

/**
 * The worker's cache name and precache list are stamped by the build, and a
 * stamp that stopped changing would be invisible: every deploy would reuse one
 * cache and serve the previous build's shell, with nothing failing anywhere.
 * So the plugin is exercised directly, and then the real build is run to prove
 * the plugin is still wired into it.
 */
type Emitted = { fileName: string; source: string }

async function run(assetNames: string[], sources?: { worker: string; html: string }) {
  const plugin = sources === undefined ? serviceWorker() : serviceWorker(sources)
  const emitted: Emitted[] = []
  const context = {
    emitFile: (file: Emitted) => emitted.push(file),
    error: (message: string) => {
      throw new Error(message)
    },
  }
  const bundle = Object.fromEntries(assetNames.map((name) => [name, { fileName: name }]))
  const hook = plugin.generateBundle
  const handler = typeof hook === 'function' ? hook : hook?.handler
  if (handler === undefined) throw new Error('the plugin registered no generateBundle hook')
  await handler.call(context as never, {} as never, bundle as never, false)
  return emitted
}

function cacheNameOf(source: string | undefined): string {
  return /const CACHE = '([^']+)'/.exec(source ?? '')?.[1] ?? ''
}

function precacheOf(source: string | undefined): string[] {
  return JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(source ?? '')?.[1] ?? 'null')
}

const ONE_BUILD = ['assets/index-aaa111.js', 'assets/index-aaa111.css']
const ANOTHER_BUILD = ['assets/index-bbb222.js', 'assets/index-aaa111.css']

const scratch = mkdtempSync(join(tmpdir(), 'philo-sw-plugin-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Stand-in sources, so a test can change one of them and watch the hash move. */
function fakeSources(html: string, worker = "const CACHE = 'philo-__PHILO_BUILD__'\nconst P = __PHILO_PRECACHE__\n") {
  const workerPath = join(scratch, `sw-${html.length}.js`)
  const htmlPath = join(scratch, `index-${html.length}.html`)
  writeFileSync(workerPath, worker)
  writeFileSync(htmlPath, html)
  return { worker: workerPath, html: htmlPath }
}

describe('the service-worker build plugin', () => {
  it('emits the worker at a stable URL, with no placeholder left in it', async () => {
    const emitted = await run(ONE_BUILD)
    expect(emitted.map((file) => file.fileName)).toEqual(['sw.js'])
    expect(emitted[0]?.source).not.toContain('__PHILO_')
  })

  it('names the cache after the build, and renames it when the build changes', async () => {
    const first = cacheNameOf((await run(ONE_BUILD))[0]?.source)
    const again = cacheNameOf((await run(ONE_BUILD))[0]?.source)
    const changed = cacheNameOf((await run(ANOTHER_BUILD))[0]?.source)

    expect(first).toMatch(/^philo-[0-9a-f]{12}$/)
    // Same build twice: the same name, or a rebuild would evict a live cache.
    expect(again).toBe(first)
    expect(changed).not.toBe(first)
  })

  it('renames the cache when only index.html changed', async () => {
    // index.html carries no content hash, so nothing else would notice.
    const before = cacheNameOf((await run(ONE_BUILD, fakeSources('<title>Philo</title>')))[0]?.source)
    const after = cacheNameOf((await run(ONE_BUILD, fakeSources('<title>Philo</title><meta name=x>')))[0]?.source)

    expect(after).not.toBe(before)
  })

  it('refuses to build a worker it cannot stamp', async () => {
    const sources = fakeSources('<title>Philo</title>', "const CACHE = 'philo-renamed-token'\n")
    await expect(run(ONE_BUILD, sources)).rejects.toThrow('__PHILO_BUILD__')
  })

  it('precaches the shell and every hashed asset, and nothing else', async () => {
    const emitted = await run([...ONE_BUILD, 'sw.js'])
    expect(precacheOf(emitted[0]?.source)).toEqual([
      '/',
      '/assets/index-aaa111.css',
      '/assets/index-aaa111.js',
    ])
  })
})

/**
 * Everything above calls the hook by hand, so all of it would still pass with
 * the plugin unplugged, or applied only to `serve`. The real build is what says
 * a deploy actually ships a worker.
 */
describe('the real build', () => {
  it('emits a stamped sw.js precaching the assets it just built', async () => {
    const result = (await build({
      ...viteConfig,
      logLevel: 'silent',
      build: { ...viteConfig.build, write: false },
    })) as Rollup.RollupOutput

    const worker = result.output.find((file) => file.fileName === 'sw.js')
    const source = worker?.type === 'asset' ? String(worker.source) : undefined
    expect(source).toBeDefined()
    expect(source).not.toContain('__PHILO_')
    expect(cacheNameOf(source)).toMatch(/^philo-[0-9a-f]{12}$/)

    const built = result.output
      .filter((file) => file.fileName.startsWith('assets/'))
      .map((file) => `/${file.fileName}`)
    expect(built.length).toBeGreaterThan(0)
    expect(precacheOf(source)).toEqual(['/', ...built.toSorted()])
  }, 60_000)
})
