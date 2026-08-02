import { ApiError, getJson, sendJson } from './http.ts'

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

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password do not match an account.',
  invalid_email: 'Enter a valid email address.',
  invalid_password: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
  invalid_request: 'The server could not read that request.',
  setup_already_complete: 'This instance already has an account. Sign in instead.',
  unauthorized: 'Your session has expired. Sign in again.',
}

/**
 * What the auth screens show a person. Anything that is not an API answer at
 * all — a dropped connection, a DNS failure — is a connection problem, not a
 * credentials problem, and must not be reported as one.
 */
export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  if (error.status === 429) {
    const seconds = error.retryAfterSeconds ?? 0
    const wait = seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.max(1, seconds)} seconds`
    return `Too many failed attempts. Try again in ${wait}.`
  }
  return MESSAGES[error.code] ?? `Something went wrong (HTTP ${error.status}).`
}

export function fetchStatus(signal?: AbortSignal): Promise<AuthStatus> {
  return getJson<AuthStatus>(`${AUTH_BASE}/status`, signal)
}

/** Resolves to undefined when nobody is signed in, rather than throwing. */
export async function fetchCurrentUser(signal?: AbortSignal): Promise<User | undefined> {
  try {
    const body = await getJson<{ user: User }>(`${AUTH_BASE}/session`, signal)
    return body.user
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return undefined
    throw error
  }
}

export async function submitSetup(input: { email: string; password: string; name?: string }): Promise<User> {
  const body = await sendJson<{ user: User }>('POST', `${AUTH_BASE}/setup`, input)
  return body.user
}

export async function submitLogin(input: { email: string; password: string }): Promise<User> {
  const body = await sendJson<{ user: User }>('POST', `${AUTH_BASE}/login`, input)
  return body.user
}

export function submitLogout(): Promise<void> {
  return sendJson<void>('POST', `${AUTH_BASE}/logout`)
}
