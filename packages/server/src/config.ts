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
  /**
   * Extra origins the PWA may `fetch` from, added to its Content-Security-Policy
   * `connect-src` — for a provider whose token or revocation endpoint is on
   * another origin than its issuer. Bare origins, empty by default.
   */
  webConnectOrigins: string[]
}

export interface ExternalIdpConfig {
  /** The issuer, exactly as its tokens' `iss` claim states it. */
  issuer: string
  /**
   * The `aud` values access tokens may carry, when the IdP sets one: a token
   * naming any of them is accepted. A list because one resource can have
   * several identifiers (the API and the MCP endpoint, RFC 8707), and the MCP
   * app forwards its token to the API.
   */
  audience: string[] | undefined
  /** The PWA's client id at that IdP: tokens it holds are the person themself. */
  clientId: string
  /**
   * Other clients at that IdP allowed in as agents. Empty by default: an IdP
   * issues tokens to every application registered with it, and only the ones
   * named here are this CRM's agents. Everything else is refused.
   */
  agentClientIds: string[]
  /** What the PWA asks the IdP for. Always holds `openid`. */
  scope: string
  /**
   * RFC 8707 resource indicators the PWA sends with its sign-in, for an IdP
   * that picks the access token's audience from them. Empty by default.
   */
  resource: string[]
  /**
   * The two scopes that admit a person and name their role — ADR-0012. Set
   * means the accounts are externally managed: one per subject, each with the
   * role its token's scopes name. Unset, an external IdP keeps one account.
   */
  roles?: RoleScopes | undefined
  /**
   * What an agent should ask the IdP for, advertised by the MCP endpoint's
   * protected-resource metadata. Defaults to the user scope plus
   * `offline_access` when the role scopes are set; otherwise unset.
   */
  agentScope?: string | undefined
}

export interface RoleScopes {
  /** Holding it admits a person as a user. */
  userScope: string
  /** Holding it makes them an admin, and admits them on its own. */
  adminScope: string
}

const DEFAULT_PORT = 3000
/** What the PWA asked an external IdP for before the scope was configurable. */
const DEFAULT_OIDC_SCOPE = 'openid email profile'
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

function parseOidcScope(raw: string | undefined, roles: RoleScopes | undefined): string {
  // The PWA's token is the IdP's whole answer for the person, so by default
  // it asks for both role scopes — ADR-0012.
  if (raw === undefined || raw.trim() === '') {
    return roles === undefined ? DEFAULT_OIDC_SCOPE : `${DEFAULT_OIDC_SCOPE} ${roles.userScope} ${roles.adminScope}`
  }
  const scopes = raw.trim().split(/\s+/)
  if (!scopes.includes('openid')) {
    throw new ConfigError(`PHILO_OIDC_SCOPE must include openid, got ${JSON.stringify(raw)}`)
  }
  // Asking for neither would get the PWA only tokens this server refuses.
  if (roles !== undefined && !scopes.includes(roles.userScope) && !scopes.includes(roles.adminScope)) {
    throw new ConfigError(
      `PHILO_OIDC_SCOPE must include ${roles.userScope} or ${roles.adminScope} (normally both), got ${JSON.stringify(raw)}`,
    )
  }
  return scopes.join(' ')
}

/**
 * RFC 6749 §3.3 scope-token: printable ASCII without space, `"` or `\`. The
 * value is also quoted into a `WWW-Authenticate` challenge, which is what the
 * two excluded characters would break.
 */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/

function parseScopeToken(name: string, raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim()
  if (value === '') return undefined
  if (!SCOPE_TOKEN.test(value)) {
    throw new ConfigError(`${name} must be a single scope, without spaces or quotes, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * Both or neither — ADR-0012: an instance whose IdP can name nobody an admin
 * cannot be configured, and one that admits everyone as a user lets in every
 * person able to sign in to anything at that IdP.
 */
function parseRoleScopes(env: NodeJS.ProcessEnv): RoleScopes | undefined {
  const userScope = parseScopeToken('PHILO_OIDC_USER_SCOPE', env['PHILO_OIDC_USER_SCOPE'])
  const adminScope = parseScopeToken('PHILO_OIDC_ADMIN_SCOPE', env['PHILO_OIDC_ADMIN_SCOPE'])
  if (userScope === undefined && adminScope === undefined) return undefined
  if (userScope === undefined || adminScope === undefined) {
    throw new ConfigError('PHILO_OIDC_USER_SCOPE and PHILO_OIDC_ADMIN_SCOPE must be set together, or neither')
  }
  if (userScope === adminScope) {
    throw new ConfigError(`PHILO_OIDC_USER_SCOPE and PHILO_OIDC_ADMIN_SCOPE must differ, both are ${JSON.stringify(userScope)}`)
  }
  return { userScope, adminScope }
}

function parseAgentScope(raw: string | undefined, roles: RoleScopes | undefined): string | undefined {
  const scopes = (raw ?? '').trim().split(/\s+/).filter((scope) => scope !== '')
  if (scopes.length === 0) return roles === undefined ? undefined : `${roles.userScope} offline_access`
  const bad = scopes.find((scope) => !SCOPE_TOKEN.test(scope))
  if (bad !== undefined) throw new ConfigError(`PHILO_OIDC_AGENT_SCOPE holds an invalid scope ${JSON.stringify(bad)}`)
  return scopes.join(' ')
}

/**
 * RFC 8707 §2: an absolute URI without a fragment. Kept exactly as written,
 * since the IdP matches it against its own registration as a string.
 */
function parseOidcResource(raw: string | undefined): string[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  for (const value of values) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new ConfigError(`PHILO_OIDC_RESOURCE values must be absolute URLs, got ${JSON.stringify(value)}`)
    }
    if (value.includes('#') || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new ConfigError(`PHILO_OIDC_RESOURCE values must be http or https URLs without a fragment, got ${JSON.stringify(value)}`)
    }
  }
  return values
}

/** Settings that only mean something when an external issuer is set. */
const EXTERNAL_ONLY = [
  'PHILO_OIDC_SCOPE',
  'PHILO_OIDC_RESOURCE',
  'PHILO_OIDC_USER_SCOPE',
  'PHILO_OIDC_ADMIN_SCOPE',
  'PHILO_OIDC_AGENT_SCOPE',
] as const

/**
 * All or nothing: an issuer without the PWA's client id would leave the app
 * itself with no client it accepts tokens from, which looks like a working
 * setup until the first sign-in.
 */
function parseExternalIdp(env: NodeJS.ProcessEnv): ExternalIdpConfig | undefined {
  const issuer = env['PHILO_OIDC_ISSUER']
  if (issuer === undefined || issuer === '') {
    // The built-in IdP's scope and resources are its own; a setting that
    // would silently do nothing is refused rather than ignored.
    const stray = EXTERNAL_ONLY.find((name) => (env[name] ?? '').trim() !== '')
    if (stray !== undefined) throw new ConfigError(`${stray} needs PHILO_OIDC_ISSUER: it applies only to an external IdP`)
    return undefined
  }
  const clientId = env['PHILO_OIDC_CLIENT_ID']
  if (clientId === undefined || clientId === '') {
    throw new ConfigError('PHILO_OIDC_CLIENT_ID is required when PHILO_OIDC_ISSUER is set')
  }
  // The issuer is compared to `iss` byte for byte, so it is kept as written
  // apart from the validation.
  parseUrl('PHILO_OIDC_ISSUER', issuer)
  // Unset or empty means no audience check. Set but naming nothing (`' '`,
  // `','`) is a mistake, and treating it as unset would fail open.
  const rawAudience = env['PHILO_OIDC_AUDIENCE'] ?? ''
  const audience = rawAudience
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  if (rawAudience !== '' && audience.length === 0) {
    throw new ConfigError('PHILO_OIDC_AUDIENCE lists no audience; leave it unset to skip the audience check')
  }
  const agentClientIds = (env['PHILO_OIDC_AGENT_CLIENT_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '' && id !== clientId)
  const roles = parseRoleScopes(env)
  return {
    issuer,
    clientId,
    audience: audience.length === 0 ? undefined : audience,
    agentClientIds,
    scope: parseOidcScope(env['PHILO_OIDC_SCOPE'], roles),
    resource: parseOidcResource(env['PHILO_OIDC_RESOURCE']),
    roles,
    agentScope: parseAgentScope(env['PHILO_OIDC_AGENT_SCOPE'], roles),
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * Each entry lands verbatim in a CSP directive, so it is held to a bare origin:
 * `https:` (plain `http:` only for local development), a plain host name or
 * IPv4 address and an optional port. A path, a wildcard, a scheme-only source or
 * a keyword (`'unsafe-inline'`, `*`, `data:`) would widen the policy past one
 * origin, so it stops the process instead.
 */
function parseOriginList(name: string, raw: string | undefined): string[] {
  const origins: string[] = []
  for (const entry of (raw ?? '').split(',').map((e) => e.trim())) {
    if (entry === '') continue
    const refuse = (why: string) =>
      new ConfigError(`${name} entries must be bare https origins (${why}), got ${JSON.stringify(entry)}`)
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      throw refuse('not an absolute URL')
    }
    if (!/^[a-z0-9.-]+$/.test(url.hostname)) throw refuse('not a plain host name')
    if (url.protocol === 'http:') {
      if (!LOCAL_HOSTS.has(url.hostname)) throw refuse('plain http only for localhost and 127.0.0.1')
    } else if (url.protocol !== 'https:') {
      throw refuse('https only')
    }
    if (url.username !== '' || url.password !== '' || /[?#@]/.test(entry)) throw refuse('no credentials, query or fragment')
    if (url.pathname !== '/') throw refuse('no path')
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return origins
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
    webConnectOrigins: parseOriginList('PHILO_WEB_CONNECT_ORIGINS', env['PHILO_WEB_CONNECT_ORIGINS']),
  }
}
