// @vitest-environment node
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import indexHtml from '../index.html?raw'
import manifestJson from '../public/manifest.webmanifest?raw'

/**
 * Installability is the acceptance criterion for the PWA, and it is a contract
 * between three files that never import each other: index.html points at the
 * manifest, the manifest points at the icons, and the icons have to be on disk.
 * Nothing else would notice a broken link until a phone refused to install.
 */
interface Manifest {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  theme_color: string
  icons: { src: string; sizes: string; type: string; purpose?: string }[]
}

const manifest = JSON.parse(manifestJson) as Manifest

function publicFile(src: string): string {
  return fileURLToPath(new URL(`../public${src}`, import.meta.url))
}

describe('web app manifest', () => {
  it('names the app as the naming table decides', () => {
    expect(manifest.name).toBe('Philo')
    expect(manifest.short_name).toBe('Philo')
  })

  it('opens standalone from the app scope', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
  })

  it('carries the icon sizes an install prompt asks for', () => {
    const any = manifest.icons.filter((icon) => icon.purpose !== 'maskable')
    expect(any.map((icon) => icon.sizes).toSorted()).toEqual(['192x192', '512x512'])
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true)
  })

  it('points every icon at a file that exists and is not empty', () => {
    for (const icon of manifest.icons) {
      expect(statSync(publicFile(icon.src)).size).toBeGreaterThan(0)
    }
  })
})

describe('index.html', () => {
  it('links the manifest', () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  })

  it('carries the iOS touch icon Safari uses on the Home Screen', () => {
    expect(indexHtml).toContain('href="/apple-touch-icon.png"')
    expect(statSync(publicFile('/apple-touch-icon.png')).size).toBeGreaterThan(0)
  })

  it('declares a theme colour for both schemes', () => {
    expect(indexHtml).toContain('media="(prefers-color-scheme: light)"')
    expect(indexHtml).toContain('media="(prefers-color-scheme: dark)"')
  })

  // Android takes the title bar colour from the manifest at install time and
  // from the page at runtime; disagreeing makes the bar change colour on launch.
  it('agrees with the manifest on the light-scheme theme colour', () => {
    expect(indexHtml).toContain(
      `content="${manifest.theme_color}" media="(prefers-color-scheme: light)"`,
    )
  })
})
