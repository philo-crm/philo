import { resolve } from 'node:path'

export interface Config {
  /** Port the HTTP server listens on. */
  port: number
  /** Directory holding all persistent state: the SQLite file and generated secrets. */
  dataDir: string
  /** Externally reachable origin, used to build absolute links. No trailing slash. */
  publicBaseUrl: string
  /**
   * Whether a reverse proxy sits in front of this process, so `X-Forwarded-For`
   * may be believed. False — the default — means the socket's peer address is the
   * caller. See `resolveClientAddress` for exactly how far the trust extends.
   */
  trustProxy: boolean
}

const DEFAULT_PORT = 3000
const DEFAULT_DATA_DIR = 'data'

class ConfigError extends Error {}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PHILO_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

function parsePublicBaseUrl(raw: string | undefined, port: number): string {
  if (raw === undefined || raw === '') return `http://localhost:${port}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`PHILO_PUBLIC_BASE_URL must be an absolute URL, got ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`PHILO_PUBLIC_BASE_URL must be http or https, got ${JSON.stringify(raw)}`)
  }
  return url.origin + url.pathname.replace(/\/$/, '')
}

/**
 * Strict rather than truthy. `PHILO_TRUSTED_PROXY=flase` silently meaning "yes"
 * would decide a security question by typo, and this setting is only ever set on
 * purpose, so there is nothing to be lenient for.
 */
function parseTrustProxy(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new ConfigError(`PHILO_TRUSTED_PROXY must be true or false, got ${JSON.stringify(raw)}`)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort(env['PHILO_PORT'])
  // An empty value counts as unset — `-e PHILO_DATA_DIR=` or an unexpanded
  // compose variable must not silently park state in the working directory.
  const dataDir = env['PHILO_DATA_DIR'] || DEFAULT_DATA_DIR
  return {
    port,
    dataDir: resolve(dataDir),
    publicBaseUrl: parsePublicBaseUrl(env['PHILO_PUBLIC_BASE_URL'], port),
    trustProxy: parseTrustProxy(env['PHILO_TRUSTED_PROXY']),
  }
}
