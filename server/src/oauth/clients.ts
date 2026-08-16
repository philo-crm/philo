import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, lt, notExists, sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { accessTokens, authorizationCodes, oauthClients, refreshTokens } from '../db/schema.ts'

const SECRET_BYTES = 32

/** Registered clients kept per instance, past which registration is refused. */
export const MAX_REGISTERED_CLIENTS = 200

/**
 * How long a freshly registered client is left alone before an unused
 * registration is swept. A client that never finished a flow — and never
 * will, because the operator closed the tab — is the common case, and the
 * endpoint that creates them is unauthenticated by construction (RFC 7591).
 * A registration in use is never touched: it holds a token or a live code.
 */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Auth methods this server accepts at the token endpoint. `none` is a public
 * client: PKCE is what protects it, and OAuth 2.1 requires PKCE either way.
 */
const AUTH_METHODS: ReadonlySet<string> = new Set(['client_secret_basic', 'client_secret_post', 'none'])

const DEFAULT_AUTH_METHOD = 'client_secret_basic'

export interface RegisteredClient {
  clientId: string
  clientName: string | null
  clientUri: string | null
  redirectUris: string[]
  /** Null for a public client, which authenticates with PKCE alone. */
  clientSecretHash: string | null
  tokenEndpointAuthMethod: string
  createdAt: Date
}

/** Same reasoning as `hashApiKey`: a 256-bit secret this server generated. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/**
 * Redirect targets this server is willing to send an authorization code to.
 *
 * https anywhere, http only on loopback (RFC 8252 §7.3, for a native client
 * listening on an ephemeral port). Everything else — custom app schemes
 * included — is refused: a single-tenant CRM's connector clients are a browser
 * or a local process, and a scheme any installed app can claim is not a place
 * to put a credential.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  // A fragment is forbidden on a redirect URI (RFC 6749 §3.1.2) and would be
  // dropped when the code is appended anyway.
  if (url.hash !== '') return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
}

export type RegistrationError =
  | 'invalid_client_metadata'
  | 'invalid_redirect_uri'
  | 'unsupported_auth_method'
  | 'too_many_clients'

export interface RegistrationResult {
  client: OAuthClientInformationFull
}

/**
 * RFC 7591 dynamic client registration.
 *
 * The issued secret never expires (`client_secret_expires_at: 0`). The
 * alternative — the SDK's 30-day default — would silently break a working
 * connector a month after it was set up, with nothing on screen saying why, and
 * the secret is 256 bits of CSPRNG output rather than anything guessable.
 */
export function registerClient(
  db: Db,
  metadata: unknown,
  now = new Date(),
): { ok: true; value: OAuthClientInformationFull } | { ok: false; error: RegistrationError } {
  const parsed = OAuthClientMetadataSchema.safeParse(metadata)
  if (!parsed.success) return { ok: false, error: 'invalid_client_metadata' }

  const redirectUris = parsed.data.redirect_uris
  if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
    return { ok: false, error: 'invalid_redirect_uri' }
  }

  const authMethod = parsed.data.token_endpoint_auth_method ?? DEFAULT_AUTH_METHOD
  if (!AUTH_METHODS.has(authMethod)) return { ok: false, error: 'unsupported_auth_method' }

  // Before the insert, so a stale registration frees the slot it is holding.
  deleteUnusedClients(db, now)
  if (countClients(db) >= MAX_REGISTERED_CLIENTS) return { ok: false, error: 'too_many_clients' }

  const clientId = randomUUID()
  const secret = authMethod === 'none' ? undefined : randomBytes(SECRET_BYTES).toString('base64url')

  db.insert(oauthClients)
    .values({
      clientId,
      clientSecretHash: secret === undefined ? null : hashSecret(secret),
      clientName: parsed.data.client_name ?? null,
      clientUri: parsed.data.client_uri ?? null,
      redirectUris: JSON.stringify(redirectUris),
      tokenEndpointAuthMethod: authMethod,
      createdAt: now,
    })
    .run()

  const issuedAt = Math.floor(now.getTime() / 1000)
  return {
    ok: true,
    value: {
      ...parsed.data,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      token_endpoint_auth_method: authMethod,
      ...(secret === undefined ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
    },
  }
}

export function getClient(db: Db, clientId: string): RegisteredClient | undefined {
  const [row] = db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1).all()
  if (row === undefined) return undefined
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    clientUri: row.clientUri,
    redirectUris: parseRedirectUris(row.redirectUris),
    clientSecretHash: row.clientSecretHash,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    createdAt: row.createdAt,
  }
}

/**
 * A row this server wrote, so malformed JSON is a corrupted database rather
 * than untrusted input — but a throw here would take down the authorize page
 * for every client, so it degrades to "no registered redirect URI" instead,
 * which fails the one client that is affected.
 */
function parseRedirectUris(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter((uri): uri is string => typeof uri === 'string')
}

/** Constant-time, so a wrong secret cannot be found one character at a time. */
export function clientSecretMatches(client: RegisteredClient, presented: string): boolean {
  if (client.clientSecretHash === null) return false
  const expected = Buffer.from(client.clientSecretHash, 'hex')
  const actual = Buffer.from(hashSecret(presented), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function countClients(db: Db): number {
  const [row] = db.select({ count: sql<number>`count(*)` }).from(oauthClients).all()
  return row?.count ?? 0
}

/**
 * Sweeps registrations that were never used and are past the grace period.
 * "Used" means holding a token or a live authorization code — the rows that
 * cascade from `oauth_clients`, so this can never delete a working connector.
 */
export function deleteUnusedClients(db: Db, now = new Date()): void {
  const cutoff = new Date(now.getTime() - UNUSED_CLIENT_TTL_MS)
  db.delete(oauthClients)
    .where(
      and(
        lt(oauthClients.createdAt, cutoff),
        notExists(
          db.select({ one: sql`1` }).from(accessTokens).where(eq(accessTokens.clientId, oauthClients.clientId)),
        ),
        notExists(
          db.select({ one: sql`1` }).from(refreshTokens).where(eq(refreshTokens.clientId, oauthClients.clientId)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(authorizationCodes)
            .where(eq(authorizationCodes.clientId, oauthClients.clientId)),
        ),
      ),
    )
    .run()
}
