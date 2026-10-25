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
  /**
   * Where the PWA is served. The first-party client's redirect URI and every
   * link an email or a push notification carries are built from it. Defaults to
   * the public base URL, which is the single-container deployment.
   */
  appUrl: string
  /** Where the MCP app is served — a resource tokens may be issued for. */
  mcpUrl: string
  /** Set when an external IdP replaces the built-in one — ADR-0006. */
  externalIdp: ExternalIdpConfig | undefined
}

export interface ExternalIdpConfig {
  /** The issuer, exactly as its tokens' `iss` claim states it. */
  issuer: string
  /** Required `aud` on access tokens, when the IdP sets one. */
  audience: string | undefined
  /** The PWA's client id at that IdP: tokens it holds are the person themself. */
  clientId: string
  /**
   * Other clients at that IdP allowed in as agents. Empty by default: an IdP
   * issues tokens to every application registered with it, and only the ones
   * named here are this CRM's agents. Everything else is refused.
   */
  agentClientIds: string[]
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

function parseUrl(name: string, raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`${name} must be an absolute URL, got ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must be http or https, got ${JSON.stringify(raw)}`)
  }
  return url.origin + url.pathname.replace(/\/$/, '')
}

function parsePublicBaseUrl(raw: string | undefined, port: number): string {
  if (raw === undefined || raw === '') return `http://localhost:${port}`
  return parseUrl('PHILO_PUBLIC_BASE_URL', raw)
}

function parseOptionalUrl(name: string, raw: string | undefined, fallback: string): string {
  return raw === undefined || raw === '' ? fallback : parseUrl(name, raw)
}

/**
 * All or nothing: an issuer without the PWA's client id would leave the app
 * itself with no client it accepts tokens from, which looks like a working
 * setup until the first sign-in.
 */
function parseExternalIdp(env: NodeJS.ProcessEnv): ExternalIdpConfig | undefined {
  const issuer = env['PHILO_OIDC_ISSUER']
  if (issuer === undefined || issuer === '') return undefined
  const clientId = env['PHILO_OIDC_CLIENT_ID']
  if (clientId === undefined || clientId === '') {
    throw new ConfigError('PHILO_OIDC_CLIENT_ID is required when PHILO_OIDC_ISSUER is set')
  }
  // The issuer is compared to `iss` byte for byte, so it is kept as written
  // apart from the validation.
  parseUrl('PHILO_OIDC_ISSUER', issuer)
  const audience = env['PHILO_OIDC_AUDIENCE']
  const agentClientIds = (env['PHILO_OIDC_AGENT_CLIENT_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '' && id !== clientId)
  return {
    issuer,
    clientId,
    audience: audience === undefined || audience === '' ? undefined : audience,
    agentClientIds,
  }
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
  const publicBaseUrl = parsePublicBaseUrl(env['PHILO_PUBLIC_BASE_URL'], port)
  return {
    port,
    dataDir: resolve(dataDir),
    publicBaseUrl,
    trustProxy: parseTrustProxy(env['PHILO_TRUSTED_PROXY']),
    appUrl: parseOptionalUrl('PHILO_APP_URL', env['PHILO_APP_URL'], publicBaseUrl),
    mcpUrl: parseOptionalUrl('PHILO_MCP_URL', env['PHILO_MCP_URL'], `${publicBaseUrl}/mcp`),
    externalIdp: parseExternalIdp(env),
  }
}
