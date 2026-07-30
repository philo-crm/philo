export interface User {
  id: number
  email: string
  name: string | null
}

export interface AuthStatus {
  needsSetup: boolean
  authenticated: boolean
}

/** Mirrors MIN_PASSWORD_LENGTH on the server, so the form can say so before posting. */
export const MIN_PASSWORD_LENGTH = 12

const AUTH_BASE = '/api/v1/auth'

export class AuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password do not match an account.',
  invalid_email: 'Enter a valid email address.',
  invalid_password: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  invalid_request: 'The server could not read that request.',
  setup_already_complete: 'This instance already has an account. Sign in instead.',
  unauthorized: 'Your session has expired. Sign in again.',
}

interface ErrorBody {
  error?: unknown
  retryAfterSeconds?: unknown
}

async function toAuthError(res: Response): Promise<AuthError> {
  let body: ErrorBody = {}
  try {
    body = (await res.json()) as ErrorBody
  } catch {
    // A non-JSON error body (a proxy's 502 page, say) leaves the generic message.
  }

  if (res.status === 429) {
    const seconds = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : 0
    const wait = seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.max(1, seconds)} seconds`
    return new AuthError(res.status, `Too many failed attempts. Try again in ${wait}.`)
  }

  const code = typeof body.error === 'string' ? body.error : ''
  return new AuthError(res.status, MESSAGES[code] ?? `Something went wrong (HTTP ${res.status}).`)
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method: 'POST',
    // The content type is load-bearing: the server refuses state-changing
    // requests that are not JSON, as one of its CSRF layers.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await toAuthError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export async function fetchStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const res = await fetch(`${AUTH_BASE}/status`, signal ? { signal } : {})
  if (!res.ok) throw await toAuthError(res)
  return (await res.json()) as AuthStatus
}

/** Resolves to undefined when nobody is signed in, rather than throwing. */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<User | undefined> {
  const res = await fetch(`${AUTH_BASE}/session`, signal ? { signal } : {})
  if (res.status === 401) return undefined
  if (!res.ok) throw await toAuthError(res)
  const body = (await res.json()) as { user: User }
  return body.user
}

export async function submitSetup(input: { email: string; password: string; name?: string }): Promise<User> {
  const body = await postJson<{ user: User }>('/setup', input)
  return body.user
}

export async function submitLogin(input: { email: string; password: string }): Promise<User> {
  const body = await postJson<{ user: User }>('/login', input)
  return body.user
}

export function submitLogout(): Promise<void> {
  return postJson<void>('/logout', {})
}
