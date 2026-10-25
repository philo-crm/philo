import { readFileSync } from 'node:fs'

/**
 * The product version, from the workspace root package.json — the one place
 * it is bumped. Resolved relative to this module so `src/` and `dist/` agree.
 */
export const VERSION: string = (() => {
  const parsed = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version?: unknown
  }
  if (typeof parsed.version !== 'string') throw new Error('No "version" string in the root package.json')
  return parsed.version
})()
