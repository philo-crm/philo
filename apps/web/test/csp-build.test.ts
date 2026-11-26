// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { build, type Rollup } from 'vite'
import viteConfig from '../vite.config.ts'

/**
 * The standalone server serves the PWA with `script-src 'self'; style-src
 * 'self'; img-src 'self'` (apps/standalone/src/csp.ts). A build that started
 * emitting an inline script, a style attribute or a `data:` asset would load a
 * blank or unstyled app with nothing failing but a console message, so the
 * real build is held to the policy here.
 */
describe('the build, under the PWA’s Content-Security-Policy', async () => {
  const result = (await build({
    ...viteConfig,
    logLevel: 'silent',
    build: { ...viteConfig.build, write: false },
  })) as Rollup.RollupOutput
  const source = (fileName: string): string => {
    const file = result.output.find((output) => output.fileName === fileName)
    if (file === undefined) throw new Error(`the build emitted no ${fileName}`)
    return file.type === 'asset' ? String(file.source) : file.code
  }
  const html = source('index.html')

  it('has no inline script in index.html', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    // Every opening tag was matched, so no script slips past the checks below.
    expect(scripts.length).toBe([...html.matchAll(/<script\b/gi)].length)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="\/assets\//)
      expect(body!.trim()).toBe('')
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/javascript:/i)
  })

  it('has no inline style in index.html', () => {
    expect(html).not.toMatch(/<style\b/i)
    expect(html).not.toMatch(/\sstyle\s*=/i)
  })

  it('loads nothing from another origin', () => {
    expect(html).not.toMatch(/\s(?:src|href)="(?:https?:)?\/\//i)
  })

  it('inlines no asset as a data: URI', () => {
    for (const file of result.output.filter((output) => output.fileName.endsWith('.css'))) {
      expect(source(file.fileName), file.fileName).not.toMatch(/url\(\s*['"]?(?:data|blob):/i)
    }
    for (const file of result.output.filter((output) => output.fileName.endsWith('.js'))) {
      expect(source(file.fileName), file.fileName).not.toMatch(/["'`]data:[a-z]+\/[a-z0-9.+-]+[;,]/i)
    }
  })
})
