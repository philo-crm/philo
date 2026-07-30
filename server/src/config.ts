import { resolve } from 'node:path'

export interface Config {
  /** Port the HTTP server listens on. */
  port: number
  /** Directory holding all persistent state: the SQLite file and generated secrets. */
  dataDir: string
  /** Externally reachable origin, used to build absolute links. No trailing slash. */
  publicBaseUrl: string
  /**
   * How many reverse proxies sit in front of this process. Zero — the default —
   * means the socket's peer address is the caller. See `clientKey` for what this
   * buys and why the count, rather than a boolean, is what makes it safe.
   */
  trustedProxyHops: number
}

const DEFAULT_PORT = 3000
const DEFAULT_DATA_DIR = 'data'

/**
 * A ceiling on the hop count. Not a technical limit — nobody is running fifteen
 * reverse proxies, and a typo like `PHILO_TRUSTED_PROXY_HOPS=100` would otherwise
 * silently reach past every real entry in the header to the client-supplied part.
 */
const MAX_TRUSTED_PROXY_HOPS = 8

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

function parseTrustedProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const hops = Number(raw)
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_TRUSTED_PROXY_HOPS) {
    throw new ConfigError(
      `PHILO_TRUSTED_PROXY_HOPS must be an integer between 0 and ${MAX_TRUSTED_PROXY_HOPS}, got ${JSON.stringify(raw)}`,
    )
  }
  return hops
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
    trustedProxyHops: parseTrustedProxyHops(env['PHILO_TRUSTED_PROXY_HOPS']),
  }
}
