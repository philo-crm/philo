import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { ExternalIdpConfig } from '../config.ts'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { normalizeEmail } from './credentials.ts'
import { hashPassword } from './password.ts'
import {
  ACCOUNT_COLUMNS,
  ROLE_CONFIRMATION_INTERVAL_MS,
  ROLES_ON_ACCOUNTS,
  sessionUserOf,
  type AccountRow,
} from './access.ts'
import type { RoleScopes } from '../config.ts'
import type { Role, SessionUser } from './session.ts'

/**
 * An OIDC provider that replaces the built-in IdP — ADR-0006. Philo becomes a
 * plain resource server: it never sees a password, and accepts the provider's
 * JWT access tokens, checked against the provider's published keys.
 */
export interface ExternalIdp extends ExternalIdpConfig {
  keys: JWTVerifyGetKey
  /**
   * The provider's userinfo endpoint, from the same discovery document as the
   * keys, or undefined when it names none. Asked only to bind a subject whose
   * access token carries no verified email.
   */
  userinfoEndpoint: () => Promise<string | undefined>
}

interface Discovery {
  keys: JWTVerifyGetKey
  userinfoEndpoint: string | undefined
}

/** An absolute URL, or nothing: a malformed endpoint is no endpoint. */
function endpointOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).href
  } catch {
    return undefined
  }
}

/**
 * Keys come from the provider's discovery document, fetched on first use
 * rather than at boot: an IdP that is briefly unreachable when Philo starts
 * should cost the requests made while it is down, not the whole process.
 */
export function createExternalIdp(config: ExternalIdpConfig): ExternalIdp {
  let discovered: Promise<Discovery> | undefined
  const discover = async (): Promise<Discovery> => {
    const res = await fetch(`${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
    if (!res.ok) throw new Error(`OIDC discovery for ${config.issuer} answered ${res.status}`)
    const document = (await res.json()) as { jwks_uri?: unknown; userinfo_endpoint?: unknown }
    if (typeof document.jwks_uri !== 'string') throw new Error(`OIDC discovery for ${config.issuer} names no jwks_uri`)
    return {
      keys: createRemoteJWKSet(new URL(document.jwks_uri)),
      userinfoEndpoint: endpointOf(document.userinfo_endpoint),
    }
  }
  const discovery = (): Promise<Discovery> =>
    (discovered ??= discover().catch((error: unknown) => {
      // A failed discovery must be retried by the next request, not cached.
      discovered = undefined
      throw error
    }))
  return {
    ...config,
    keys: async (header, token) => (await discovery()).keys(header, token),
    userinfoEndpoint: async () => (await discovery()).userinfoEndpoint,
  }
}

/**
 * The user an external token acts for, and the client that holds it. With
 * the role scopes set, `user.role` is the role the token's scopes name, which
 * may be less than the account's — ADR-0012.
 */
export interface ExternalPrincipal {
  user: SessionUser
  clientId: string
}

/**
 * A token that verifies but is refused with 403 rather than 401 — ADR-0012:
 * the token is good, and asking for it again unchanged would not help.
 *
 * - `insufficient_scope`: it holds neither role scope.
 * - `account_disabled`: its account was deactivated in Philo.
 */
export interface ExternalRefusal {
  refused: 'insufficient_scope' | 'account_disabled'
}

/**
 * The scopes a token holds: `scope` (RFC 9068, space-separated) and `scp`,
 * which some providers send as an array and some as a string.
 */
export function scopesOf(claims: JWTPayload): Set<string> {
  const scopes: string[] = []
  for (const value of [claims['scope'], claims['scp']]) {
    if (typeof value === 'string') scopes.push(...value.split(/\s+/))
    else if (Array.isArray(value)) scopes.push(...value.filter((scope): scope is string => typeof scope === 'string'))
  }
  return new Set(scopes.filter((scope) => scope !== ''))
}

/** Admin implies user: a token with the admin scope alone is an admin. */
function roleOf(scopes: Set<string>, roles: RoleScopes): Role | undefined {
  if (scopes.has(roles.adminScope)) return 'admin'
  if (scopes.has(roles.userScope)) return 'user'
  return undefined
}

/** A compact JWS has three dot-separated parts; anything else is not ours to check. */
function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3
}

/** OIDC Core names the client `azp`; RFC 9068 access tokens call it `client_id`. */
function clientOf(claims: JWTPayload): string | undefined {
  const value = claims['azp'] ?? claims['client_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The PWA, a listed agent, or — with `*` — any client, but only where the
 * audience (checked against `aud`) and the role scopes (checked before any
 * account is touched) do the allow-list's job: ADR-0012. Config refuses `*`
 * without them; this refuses it again rather than fail open on an idp built
 * some other way.
 */
function admitsClient(idp: ExternalIdp, clientId: string): boolean {
  if (clientId === idp.clientId) return true
  if (idp.agentClientIds !== '*') return idp.agentClientIds.includes(clientId)
  return idp.audience !== undefined && idp.audience.length > 0 && idp.roles !== undefined
}

/**
 * The principal behind an external access token, or undefined for a token
 * that does not verify. Network failures reaching the IdP propagate — a 401
 * would tell a client to discard a token that may be perfectly good.
 */
export async function verifyExternalToken(
  db: Db,
  idp: ExternalIdp,
  token: string,
): Promise<ExternalPrincipal | ExternalRefusal | undefined> {
  if (!looksLikeJwt(token)) return undefined
  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(token, idp.keys, {
      issuer: idp.issuer,
      ...(idp.audience === undefined ? {} : { audience: idp.audience }),
    }))
  } catch (error) {
    if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) return undefined
    throw error
  }

  // An id_token sent where an access token belongs proves identity, not
  // authorisation. Providers that mark the difference do so with `typ`; for
  // the rest, PHILO_OIDC_AUDIENCE is what keeps the two apart.
  if (claims['typ'] === 'ID') return undefined

  // Fail closed on the client. An IdP issues tokens to every application
  // registered with it, and a valid signature says only that one of them was
  // issued this — so a token that names no client, or a client nobody listed,
  // is refused rather than let in to act for anyone.
  const clientId = clientOf(claims)
  if (clientId === undefined || !admitsClient(idp, clientId)) return undefined

  // The PWA and a listed agent alike act for the user the token names —
  // ADR-0007 — so both are resolved the same way, by the bound subject.
  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined
  const sub = claims.sub
  const subject = `${idp.issuer} ${sub}`
  const userinfo = () => fetchUserinfo(idp, token, sub)

  if (idp.roles === undefined) {
    const user = await findOrProvisionOnlyAccount(db, subject, claims, userinfo)
    if (user === undefined) return undefined
    // Nothing reads the confirmation in this mode. Kept fresh so that turning
    // the role scopes on later does not find the account's keys long lapsed.
    keepConfirmed(db, user.id)
    return { user, clientId }
  }

  // ADR-0012. The scope is checked before anything touches an account, so a
  // token without it can never claim or create one — and a refusal changes
  // nothing, because a client that did not ask for the scope looks the same
  // as a person who lost it.
  const role = roleOf(scopesOf(claims), idp.roles)
  if (role === undefined) return { refused: 'insufficient_scope' }

  const account = await findOrProvisionAccount(db, subject, claims, userinfo, role)
  if (account === undefined) return undefined
  // Philo's one override of the IdP: no scope gets a deactivated account in.
  if (account.disabledAt !== null) return { refused: 'account_disabled' }
  confirmRole(db, account, role, clientId === idp.clientId)
  return { user: { id: account.id, email: account.email, name: account.name, role }, clientId }
}

/** Refreshes `role_confirmed_at` once it is an interval old, and otherwise writes nothing. */
function keepConfirmed(db: Db, userId: number, now = new Date()): void {
  const due = new Date(now.getTime() - ROLE_CONFIRMATION_INTERVAL_MS)
  db.update(users)
    .set({ roleConfirmedAt: now })
    .where(and(eq(users.id, userId), or(isNull(users.roleConfirmedAt), lt(users.roleConfirmedAt, due))))
    .run()
}

/**
 * The stored role is a cache of the IdP's answer, for whatever never sees a
 * token (API keys, push, email, the last-admin guard) — ADR-0012. Any
 * admitted token confirms it, and one with the admin scope sets admin. Only
 * the PWA's token demotes: it asks for both scopes, so it is the IdP's whole
 * answer, while an agent's names only what that agent asked for. No token
 * sets the role to null.
 */
function confirmRole(db: Db, account: AccountRow, tokenRole: Role, fromPwa: boolean, now = new Date()): void {
  const role: Role = tokenRole === 'admin' || fromPwa ? tokenRole : (account.role ?? tokenRole)
  const stale =
    account.roleConfirmedAt === null || now.getTime() - account.roleConfirmedAt.getTime() >= ROLE_CONFIRMATION_INTERVAL_MS
  if (role === account.role && !stale) return
  db.update(users).set({ role, roleConfirmedAt: now }).where(eq(users.id, account.id)).run()
}

/** A slow provider costs one request this long, not a hung one. */
export const USERINFO_TIMEOUT_MS = 10_000
/** A profile is a few hundred bytes; anything this large is not one. */
export const MAX_USERINFO_BYTES = 16 * 1024

/**
 * The provider's profile of the token's subject, from its userinfo endpoint
 * (OIDC Core §5.3), or undefined for an answer that vouches for nothing. An
 * RFC 9068 access token often carries no profile claims at all; the email
 * that binds the account is then only here.
 *
 * Like key discovery, a provider that cannot be reached — or fails on its own
 * side — throws rather than refuses: a 401 would tell the client to discard a
 * token that may be perfectly good.
 */
async function fetchUserinfo(idp: ExternalIdp, token: string, sub: string): Promise<JWTPayload | undefined> {
  const endpoint = await idp.userinfoEndpoint()
  if (endpoint === undefined) return undefined
  const res = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    // A redirect would carry the token somewhere discovery never named.
    redirect: 'manual',
    signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
  })
  if (res.status >= 500) throw new Error(`OIDC userinfo for ${idp.issuer} answered ${res.status}`)
  if (res.status !== 200) {
    await res.body?.cancel()
    return undefined
  }
  const body = await readCapped(res, MAX_USERINFO_BYTES)
  if (body === undefined) return undefined
  let profile: unknown
  try {
    profile = JSON.parse(body)
  } catch {
    // Includes a signed (application/jwt) answer, which this does not read.
    return undefined
  }
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return undefined
  // §5.3.2: the answer must be about the subject the token names, or it
  // could be a profile substituted for someone else's.
  const claims = profile as JWTPayload
  return claims.sub === sub ? claims : undefined
}

/** The body as text, or undefined once it passes `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel()
    return undefined
  }
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Without the role scopes, the stored role decides, as with the built-in IdP. */
const USER_COLUMNS = ACCOUNT_COLUMNS
const access = (row: Parameters<typeof sessionUserOf>[0]) => sessionUserOf(row, ROLES_ON_ACCOUNTS)

/** Positive proof only: a provider that says nothing about the address has not vouched for it. */
function verifiedEmail(claims: JWTPayload): string | undefined {
  if (claims['email_verified'] !== true) return undefined
  return normalizeEmail(claims['email'])
}

/** The name a profile gives, trimmed and bounded, or null. */
function nameOf(profile: JWTPayload): string | null {
  const raw = profile['name']
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 200) : null
}

/** A password nobody knows: the built-in sign-in is switched off while an external IdP issues tokens. */
const unusablePassword = () => hashPassword(`external-idp:${randomUUID()}`)

/**
 * The account an admitted token names when the role scopes are set —
 * ADR-0012, one account per `iss`+`sub`:
 *
 * - **Bound subject:** that account.
 * - **Unbound, and an account never bound holds the verified email** (the
 *   token's, or userinfo's when the token carries none): that account is
 *   bound to the subject, once.
 * - **Otherwise** a new account, with the verified email, the profile's name
 *   and the role the token names. An address held by an account bound to
 *   another subject is refused: two people cannot share one.
 *
 * The row comes back whatever its state; the caller decides on deactivation.
 * A deactivated account never bound comes back without being bound.
 */
async function findOrProvisionAccount(
  db: Db,
  subject: string,
  claims: JWTPayload,
  userinfo: () => Promise<JWTPayload | undefined>,
  role: Role,
): Promise<AccountRow | undefined> {
  const boundTo = (q: Pick<Db, 'select'>): AccountRow | undefined =>
    q.select(ACCOUNT_COLUMNS).from(users).where(eq(users.externalSubject, subject)).all()[0]
  const bound = boundTo(db)
  if (bound !== undefined) return bound

  // Userinfo is asked once per new subject, and only when the token itself
  // vouches for no address.
  const profile = verifiedEmail(claims) === undefined ? await userinfo() : claims
  if (profile === undefined) return undefined
  const email = verifiedEmail(profile)
  if (email === undefined) return undefined

  const holder = db
    .select({ ...ACCOUNT_COLUMNS, subject: users.externalSubject })
    .from(users)
    .where(eq(users.email, email))
    .all()[0]
  if (holder !== undefined) {
    if (holder.subject !== null) return boundTo(db)
    // Deactivated: handed back unbound, so the caller's refusal changes nothing.
    if (holder.disabledAt !== null) return holder
    const [claimed] = db
      .update(users)
      .set({ externalSubject: subject })
      .where(and(eq(users.email, email), isNull(users.externalSubject)))
      .returning(ACCOUNT_COLUMNS)
      .all()
    // Lost a race to a parallel request: it bound the address, to this
    // subject (shared) or another (refused).
    return claimed ?? boundTo(db)
  }

  const passwordHash = await unusablePassword()
  return db.transaction((tx) => {
    // The hash above yielded, so anything may have happened since: another
    // token of this subject provisioned it, or someone took the address.
    const raced = boundTo(tx)
    if (raced !== undefined) return raced
    if (tx.select({ id: users.id }).from(users).where(eq(users.email, email)).all().length > 0) return undefined
    const [created] = tx
      .insert(users)
      .values({ email, passwordHash, name: nameOf(profile), externalSubject: subject, role, roleConfirmedAt: new Date() })
      .returning(ACCOUNT_COLUMNS)
      .all()
    return created
  })
}

/**
 * The user an external token names when the role scopes are not set: the
 * single-account behaviour from before ADR-0012. Bound to the IdP's stable subject —
 * an email address can be changed at the IdP, `iss`+`sub` cannot — and the
 * email is consulted only to make that binding, never to match afterwards:
 *
 * - **Known subject:** that account.
 * - **No account yet:** the first token with a verified email creates one.
 *   This is the external equivalent of first-boot setup, bounded the same
 *   way: only someone the operator's IdP issues a token to, for one of the
 *   clients configured here, gets here.
 * - **An account never bound** (an instance that used the built-in IdP until
 *   now): a verified email matching it binds it, once.
 *
 * The verified email is the token's own when it carries one, and otherwise
 * the one the provider's userinfo vouches for.
 *
 * Anything else — a second person, an address already bound to another
 * subject — is refused. Userinfo is asked only on the unbound path, so it
 * costs one request per account, once.
 */
async function findOrProvisionOnlyAccount(
  db: Db,
  subject: string,
  claims: JWTPayload,
  userinfo: () => Promise<JWTPayload | undefined>,
): Promise<SessionUser | undefined> {
  // Every path below hands back an account row, and every row goes through
  // the has-access rule before it acts for anyone — ADR-0012.
  const boundTo = (q: Pick<Db, 'select'>): AccountRow | undefined =>
    q.select(USER_COLUMNS).from(users).where(eq(users.externalSubject, subject)).all()[0]
  const bound = boundTo(db)
  if (bound !== undefined) return access(bound)

  // Nothing left to bind: refuse before asking the provider anything, so a
  // second person's every request is not also a userinfo call.
  const empty = db.select({ id: users.id }).from(users).limit(1).all().length === 0
  if (!empty && db.select({ id: users.id }).from(users).where(isNull(users.externalSubject)).limit(1).all().length === 0) {
    return undefined
  }

  // The token's own email wins when it vouches for one; the name travels
  // with whichever claims supplied the email.
  const profile = verifiedEmail(claims) === undefined ? await userinfo() : claims
  if (profile === undefined) return undefined
  const email = verifiedEmail(profile)
  if (email === undefined) return undefined

  if (!empty) {
    const [unbound] = db
      .update(users)
      .set({ externalSubject: subject })
      .where(and(eq(users.email, email), isNull(users.externalSubject)))
      .returning(USER_COLUMNS)
      .all()
    // Lost a race to a parallel request carrying this same subject (another
    // tab, an agent): that request bound the account, so this one shares it.
    // A different subject still finds nothing and is refused.
    return access(unbound ?? boundTo(db))
  }

  // If the built-in sign-in is ever switched back on, the operator resets
  // rather than inherits.
  const passwordHash = await unusablePassword()
  const name = nameOf(profile)
  return db.transaction((tx) => {
    // Lost a race with another first token: whoever won is the operator. If
    // the winner carried this same subject, this request is that operator too.
    if (tx.select({ id: users.id }).from(users).limit(1).all().length > 0) return access(boundTo(tx))
    const [created] = tx
      .insert(users)
      // Without the role scopes there is one account, and it runs the
      // instance — ADR-0012.
      .values({ email, passwordHash, name, externalSubject: subject, role: 'admin', roleConfirmedAt: new Date() })
      .returning(USER_COLUMNS)
      .all()
    return access(created)
  })
}
