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
  /** The operator host script the PWA loads after sign-in — ADR-0013. Off by default. */
  webHost: WebHostConfig
  /**
   * `PHILO_WEB_ASSET_ORIGINS` — ADR-0013: where the host script's own
   * assets come from, added to `script-src`, `style-src` and `font-src` as
   * given and to `img-src` by origin. Each an origin, or an origin and a path
   * prefix ending in `/`. Empty by default.
   */
  webAssetOrigins: string[]
}

/** ADR-0013. Environment only: a script URL is code execution in every person's browser. */
export interface WebHostConfig {
  /**
   * `PHILO_WEB_HOST_SCRIPT_URL`: an absolute `https:` URL (plain `http:` only
   * for localhost and 127.0.0.1), or a path on the PWA's own origin. Unset
   * means no script, and the PWA's policy stays `'self'`.
   */
  scriptUrl: string | undefined
  /** `PHILO_WEB_HOST_CONFIG`: handed to the script verbatim. Public, so no secrets. */
  config: Record<string, unknown>
  /**
   * `PHILO_WEB_HOST_TOKEN_RESOURCES`: the RFC 8707 resources the script may
   * ask the IdP for a token for. Never Philo's own audience.
   */
  tokenResources: string[]
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

function parseOidcScope(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_OIDC_SCOPE
  const scopes = raw.trim().split(/\s+/)
  if (!scopes.includes('openid')) {
    throw new ConfigError(`PHILO_OIDC_SCOPE must include openid, got ${JSON.stringify(raw)}`)
  }
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
const EXTERNAL_ONLY = ['PHILO_OIDC_SCOPE', 'PHILO_OIDC_RESOURCE'] as const

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
  return {
    issuer,
    clientId,
    audience: audience.length === 0 ? undefined : audience,
    agentClientIds,
    scope: parseOidcScope(env['PHILO_OIDC_SCOPE']),
    resource: parseOidcResource(env['PHILO_OIDC_RESOURCE']),
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
 * The characters a host script URL's path may hold. It lands in `script-src`
 * as an exact URL, so nothing that ends a source (whitespace, `,`, `;`) or
 * reads as a keyword's quote may get there; `URL` percent-encodes whitespace
 * but leaves the rest alone. It must not end in `/`, which CSP reads as a
 * prefix rather than that exact URL, and holds no `%`: a server may decode
 * `%2F` or `%5C` before routing, as with the asset prefixes.
 */
const SAFE_URL_PATH = /^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/

/** A dot segment, plain or percent-encoded: refused rather than left to whoever resolves it. */
const DOT_SEGMENT = /(^|\/)(\.|%2e){1,2}(\/|$)/i

function parseHostScriptUrl(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim()
  if (value === '') return undefined
  const refuse = (why: string) =>
    new ConfigError(
      `PHILO_WEB_HOST_SCRIPT_URL must be an absolute https URL or a path on the app's origin (${why}), got ${JSON.stringify(value)}`,
    )
  if (value.includes('#')) throw refuse('no fragment')
  const [path = '', query] = splitQuery(value)
  if (value.startsWith('/')) {
    // `//host` and `/\host` are other origins to a browser.
    if (!SAFE_URL_PATH.test(path) || path.startsWith('//')) throw refuse('a plain path')
    if (DOT_SEGMENT.test(path)) throw refuse('no dot segments')
    if (query !== undefined && /\s/.test(query)) throw refuse('no whitespace')
    return value
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw refuse('not an absolute URL')
  }
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) throw refuse('not a plain host name')
  if (url.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(url.hostname)) throw refuse('plain http only for localhost and 127.0.0.1')
  } else if (url.protocol !== 'https:') {
    throw refuse('https only')
  }
  if (url.username !== '' || url.password !== '' || value.slice(0, value.indexOf(url.host)).includes('@')) {
    throw refuse('no credentials')
  }
  // As written, so the URL in the policy is the one the PWA loads.
  const rawPath = path.slice(path.indexOf('//') + 2).replace(/^[^/]*/, '')
  if (rawPath !== url.pathname || !SAFE_URL_PATH.test(url.pathname) || DOT_SEGMENT.test(url.pathname)) {
    throw refuse('a plain path')
  }
  if (query !== undefined && /\s/.test(query)) throw refuse('no whitespace')
  return url.href
}

function splitQuery(value: string): [string, string | undefined] {
  const at = value.indexOf('?')
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)]
}

function parseHostConfig(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ConfigError(`PHILO_WEB_HOST_CONFIG must be a JSON object, got ${JSON.stringify(raw)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`PHILO_WEB_HOST_CONFIG must be a JSON object, got ${JSON.stringify(raw)}`)
  }
  return value as Record<string, unknown>
}

/**
 * Compared as parsed URLs, so the case of the scheme and host and a default
 * port don't matter, and without a trailing slash: an IdP treats `…/api` and
 * `…/api/` as one audience often enough. A value that doesn't parse is
 * compared as written.
 */
function sameResource(a: string, b: string): boolean {
  return normalResource(a) === normalResource(b)
}

function normalResource(value: string): string {
  let href = value
  try {
    href = new URL(value).href
  } catch {
    // As written.
  }
  return href.replace(/\/+$/, '')
}

/**
 * RFC 8707 resources, as `PHILO_OIDC_RESOURCE`. `own` is everything a token
 * for Philo itself is for: a host script must never be able to mint one.
 */
function parseHostTokenResources(raw: string | undefined, own: readonly string[]): string[] {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  for (const value of values) {
    let url: URL | undefined
    try {
      url = new URL(value)
    } catch {
      url = undefined
    }
    if (url === undefined || value.includes('#') || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new ConfigError(
        `PHILO_WEB_HOST_TOKEN_RESOURCES values must be http or https URLs without a fragment, got ${JSON.stringify(value)}`,
      )
    }
    if (own.some((mine) => sameResource(mine, value))) {
      throw new ConfigError(
        `PHILO_WEB_HOST_TOKEN_RESOURCES must not name Philo's own audience, got ${JSON.stringify(value)}`,
      )
    }
  }
  return values
}

/** A path prefix's segments: nothing a CSP reads specially, and no `%`, which a server may decode before routing. */
const SAFE_PATH_PREFIX = /^(\/[A-Za-z0-9._~-]+)*\/$/

/**
 * Each entry lands verbatim in `script-src`, so it is held to an origin
 * (`https:`, plain `http:` only for local development), optionally with a
 * path prefix ending in `/`. A wildcard, a scheme-only source, a keyword, a
 * nonce or hash, a query, a fragment or a dot segment stops the process
 * instead. ADR-0013 says why a path is defense in depth, not a boundary.
 */
function parseAssetOrigins(raw: string | undefined): string[] {
  const name = 'PHILO_WEB_ASSET_ORIGINS'
  const sources: string[] = []
  for (const entry of (raw ?? '').split(',').map((e) => e.trim())) {
    if (entry === '') continue
    const refuse = (why: string) =>
      new ConfigError(
        `${name} entries must be https origins, optionally with a path prefix ending in / (${why}), got ${JSON.stringify(entry)}`,
      )
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
    // The path as written, so a dot segment the parser would resolve away is
    // refused rather than quietly changed into a different prefix.
    const afterScheme = entry.slice(entry.indexOf('//') + 2)
    const slash = afterScheme.indexOf('/')
    const rawPath = slash === -1 ? '/' : afterScheme.slice(slash)
    if (rawPath !== url.pathname || !SAFE_PATH_PREFIX.test(rawPath) || /(^|\/)\.\.?\//.test(rawPath)) {
      throw refuse('a path prefix is plain segments ending in /')
    }
    const source = url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`
    if (!sources.includes(source)) sources.push(source)
  }
  return sources
}

/** Settings that only mean something beside a host script. */
const HOST_SCRIPT_ONLY = ['PHILO_WEB_HOST_CONFIG', 'PHILO_WEB_HOST_TOKEN_RESOURCES', 'PHILO_WEB_ASSET_ORIGINS'] as const

function parseWebHost(
  env: NodeJS.ProcessEnv,
  urls: { publicBaseUrl: string; mcpUrl: string },
  externalIdp: ExternalIdpConfig | undefined,
): WebHostConfig {
  const scriptUrl = parseHostScriptUrl(env['PHILO_WEB_HOST_SCRIPT_URL'])
  if (scriptUrl === undefined) {
    const stray = HOST_SCRIPT_ONLY.find((name) => (env[name] ?? '').trim() !== '')
    if (stray !== undefined) throw new ConfigError(`${stray} needs PHILO_WEB_HOST_SCRIPT_URL: it applies only to a host script`)
  }
  const own =
    externalIdp === undefined
      ? [urls.publicBaseUrl, urls.mcpUrl]
      : [...(externalIdp.audience ?? []), ...externalIdp.resource]
  const tokenResources = parseHostTokenResources(env['PHILO_WEB_HOST_TOKEN_RESOURCES'], own)
  // With no audience, Philo's API checks none: any token the issuer gives the
  // PWA's client would act there, whatever resource it was asked for.
  if (tokenResources.length > 0 && externalIdp !== undefined && externalIdp.audience === undefined) {
    throw new ConfigError(
      "PHILO_WEB_HOST_TOKEN_RESOURCES needs PHILO_OIDC_AUDIENCE: without it, a token the host script gets could act at Philo's API",
    )
  }
  return {
    scriptUrl,
    config: parseHostConfig(env['PHILO_WEB_HOST_CONFIG']),
    tokenResources,
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
  const mcpUrl = parseOptionalUrl('PHILO_MCP_URL', env['PHILO_MCP_URL'], `${publicBaseUrl}/mcp`)
  const externalIdp = parseExternalIdp(env)
  return {
    port,
    dataDir: resolve(dataDir),
    publicBaseUrl,
    trustProxy: parseTrustProxy(env['PHILO_TRUSTED_PROXY']),
    appUrl: parseOptionalUrl('PHILO_APP_URL', env['PHILO_APP_URL'], publicBaseUrl),
    mcpUrl,
    externalIdp,
    webConnectOrigins: parseOriginList('PHILO_WEB_CONNECT_ORIGINS', env['PHILO_WEB_CONNECT_ORIGINS']),
    webHost: parseWebHost(env, { publicBaseUrl, mcpUrl }, externalIdp),
    webAssetOrigins: parseAssetOrigins(env['PHILO_WEB_ASSET_ORIGINS']),
  }
}
