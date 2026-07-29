import { readFileSync } from 'node:fs'

/**
 * The product version, read from the workspace root package.json — the single
 * place the version is bumped. Resolved relative to this module so it works
 * from `src/` (dev, tests) and `dist/` (build, container) alike.
 */
export const VERSION: string = readVersion()

function readVersion(): string {
  const packageJsonUrl = new URL('../../package.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf8'))
  const version =
    typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined
  if (typeof version !== 'string') {
    throw new Error(`No "version" string in ${packageJsonUrl.pathname}`)
  }
  return version
}
