import {
  createAuthorizationRequest,
  discover,
  exchangeCode,
  OidcError,
  TokenSession,
  type AuthConfig,
  type OidcMetadata,
  type PendingAuthorization,
  type RefreshTokenStore,
  type User,
} from '@philo/sdk'
import { philo, setAccessTokenSource } from './client.ts'
import { ApiError } from './http.ts'

export type { User }

/**
 * Sign-in is the IdP's job (ADR-0006): the PWA sends the browser to its
 * authorize page, which handles first-boot setup as well as the password, and
 * finishes the authorization code + PKCE exchange when it comes back here.
 */

/** Must match FIRST_PARTY_CALLBACK_PATH on the server, which builds the registered redirect URI from it. */
export const CALLBACK_PATH = '/auth/callback'

export const REFRESH_TOKEN_KEY = 'philo.refresh-token'
const PENDING_KEY = 'philo.pending-authorization'

/** Everything a signed-in or signing-in page needs, built once per load. */
export interface Auth {
  config: AuthConfig
  metadata: OidcMetadata
  session: TokenSession
}

interface StoredPending extends PendingAuthorization {
  /** Where to land after the round trip, so a 401 on /spam signs back in to /spam. */
  returnTo: string
}

/** Storage can throw (Safari private mode, disabled cookies); that costs staying signed in across loads, nothing more. */
const refreshTokenStore: RefreshTokenStore = {
  load() {
    try {
      return window.localStorage.getItem(REFRESH_TOKEN_KEY) ?? undefined
    } catch {
      return undefined
    }
  },
  save(token) {
    try {
      if (token === undefined) window.localStorage.removeItem(REFRESH_TOKEN_KEY)
      else window.localStorage.setItem(REFRESH_TOKEN_KEY, token)
    } catch {
      // The session still holds the token in memory for this load.
    }
  },
}

/**
 * The one way this module leaves the page. An object rather than a bare call so
 * tests can watch the redirect: jsdom cannot navigate, and `window.location`'s
 * own methods cannot be replaced.
 */
export const browser = {
  assign(url: string): void {
    window.location.assign(url)
  },
}

/** Learns where to sign in and wires the resulting session into the API client. */
export async function loadAuth(): Promise<Auth> {
  const config = await philo.auth.config()
  const metadata = await discover(config.issuer)
  const session = new TokenSession({ metadata, clientId: config.clientId, store: refreshTokenStore })
  setAccessTokenSource(session.accessToken)
  return { config, metadata, session }
}

function redirectUri(): string {
  return `${window.location.origin}${CALLBACK_PATH}`
}

function currentLocation(): string {
  const { pathname, search } = window.location
  return pathname === CALLBACK_PATH ? '/' : `${pathname}${search}`
}

export async function beginSignIn(auth: Auth): Promise<void> {
  const pending = await createAuthorizationRequest({
    metadata: auth.metadata,
    clientId: auth.config.clientId,
    redirectUri: redirectUri(),
    scope: auth.config.scope,
  })
  const stored: StoredPending = { ...pending, returnTo: currentLocation() }
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(stored))
  } catch {
    // Carry on: the callback will say it has nothing to match, which is the
    // truth, rather than leaving a button that silently does nothing.
  }
  browser.assign(pending.url)
}

function takePending(): StoredPending | undefined {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY)
    // Removed on the way out: a pending request is good for one callback, and
    // a reload of the callback URL must not try to spend the code twice.
    window.sessionStorage.removeItem(PENDING_KEY)
    return raw === null ? undefined : (JSON.parse(raw) as StoredPending)
  } catch {
    return undefined
  }
}

/** Finishes the round trip and answers with where to go next. */
export async function completeSignIn(auth: Auth): Promise<string> {
  const pending = takePending()
  if (pending === undefined) {
    throw new OidcError('no_pending_authorization', 'This browser has no sign-in waiting to be finished.')
  }
  const tokens = await exchangeCode({
    metadata: auth.metadata,
    clientId: auth.config.clientId,
    pending,
    callbackUrl: window.location.href,
  })
  auth.session.set(tokens)
  return pending.returnTo
}

export function signOut(auth: Auth): Promise<void> {
  return auth.session.signOut()
}

/** Resolves to undefined when the session is gone, rather than throwing. */
export async function fetchCurrentUser(auth: Auth): Promise<User | undefined> {
  if (!auth.session.hasCredentials) return undefined
  try {
    return await philo.auth.session()
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    auth.session.clear()
    return undefined
  }
}

const SIGN_IN_MESSAGES: Record<string, string> = {
  access_denied: 'Sign-in was cancelled.',
  state_mismatch: 'That sign-in response does not match the one this browser started.',
  nonce_mismatch: 'That sign-in response does not match the one this browser started.',
  no_pending_authorization: 'That sign-in was started in another tab or has already been finished.',
  invalid_grant: 'That sign-in has expired or was already used.',
}

/**
 * What the signed-out screen shows after a failed round trip. Anything that is
 * not an answer from the IdP — a dropped connection — is a connection problem
 * and must not read as a refusal.
 */
export function signInErrorMessage(error: unknown): string {
  if (!(error instanceof OidcError)) return 'Could not reach the server. Check your connection and try again.'
  return SIGN_IN_MESSAGES[error.code] ?? `Sign-in failed (${error.code}).`
}
