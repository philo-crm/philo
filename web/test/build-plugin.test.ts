// @vitest-environment node
import { describe, expect, it } from 'vitest'
import viteConfig, { serviceWorker } from '../vite.config.ts'

/**
 * The worker's cache name is stamped by the build, and a stamp that stopped
 * changing would be invisible: every deploy would reuse one cache and serve the
 * previous build's shell, with nothing failing anywhere. So the plugin is
 * exercised directly, and so is the fact that it is actually wired in.
 */
type Emitted = { fileName: string; source: string }

interface RunResult {
  emitted: Emitted[]
  errors: string[]
}

async function run(assetNames: string[]): Promise<RunResult> {
  const plugin = serviceWorker()
  const emitted: Emitted[] = []
  const errors: string[] = []
  const context = {
    emitFile: (file: Emitted) => emitted.push(file),
    error: (message: string) => {
      errors.push(message)
      throw new Error(message)
    },
  }
  const bundle = Object.fromEntries(assetNames.map((name) => [name, { fileName: name }]))
  const hook = plugin.generateBundle
  const handler = typeof hook === 'function' ? hook : hook?.handler
  if (handler === undefined) throw new Error('the plugin registered no generateBundle hook')
  await handler.call(context as never, {} as never, bundle as never, false)
  return { emitted, errors }
}

function cacheNameOf(source: string): string {
  return /const CACHE = '([^']+)'/.exec(source)?.[1] ?? ''
}

const ONE_BUILD = ['assets/index-aaa111.js', 'assets/index-aaa111.css']
const ANOTHER_BUILD = ['assets/index-bbb222.js', 'assets/index-aaa111.css']

describe('the service-worker build plugin', () => {
  it('is wired into the build', () => {
    const plugins = [viteConfig.plugins].flat(2)
    expect(plugins.some((plugin) => plugin && 'name' in plugin && plugin.name === 'philo:service-worker')).toBe(true)
  })

  it('emits the worker at a stable URL', async () => {
    const { emitted } = await run(ONE_BUILD)
    expect(emitted.map((file) => file.fileName)).toEqual(['sw.js'])
  })

  it('leaves no placeholder in the shipped file', async () => {
    const [file] = (await run(ONE_BUILD)).emitted
    expect(file?.source).not.toContain('__PHILO_')
  })

  it('names the cache after the build, and renames it when the build changes', async () => {
    const [first] = (await run(ONE_BUILD)).emitted
    const [again] = (await run(ONE_BUILD)).emitted
    const [changed] = (await run(ANOTHER_BUILD)).emitted

    expect(cacheNameOf(first?.source ?? '')).toMatch(/^philo-[0-9a-f]{12}$/)
    // Same build twice: the same name, or a rebuild would evict a live cache.
    expect(cacheNameOf(again?.source ?? '')).toBe(cacheNameOf(first?.source ?? ''))
    expect(cacheNameOf(changed?.source ?? '')).not.toBe(cacheNameOf(first?.source ?? ''))
  })

  it('precaches the shell and every hashed asset, and nothing else', async () => {
    const [file] = (await run([...ONE_BUILD, 'sw.js'])).emitted
    const precache = JSON.parse(/const PRECACHE = (\[[^\]]*\])/.exec(file?.source ?? '')?.[1] ?? '[]')

    expect(precache).toEqual(['/', '/assets/index-aaa111.css', '/assets/index-aaa111.js'])
  })
})
