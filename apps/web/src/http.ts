/**
 * One fetch wrapper for every authenticated call. The API answers errors as
 * `{ error: "<code>" }`, so a caller only ever has to look at `status` and
 * `code` — the human sentence is the calling module's business, because the
 * same code reads differently on a login screen and on a lead.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Only the login and intake throttles send this. */
  readonly retryAfterSeconds: number | undefined
  /**
   * A sentence from something the server was talking to, when the code alone
   * cannot say what went wrong — today only the SMTP test-send, where "535
   * authentication failed" is the entire value of the answer.
   */
  readonly detail: string | undefined

  constructor(status: number, code: string, retryAfterSeconds?: number, detail?: string) {
    super(`HTTP ${status}${code === '' ? '' : ` (${code})`}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
    this.detail = detail
  }
}

interface ErrorBody {
  error?: unknown
  retryAfterSeconds?: unknown
  detail?: unknown
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody = {}
  try {
    body = (await res.json()) as ErrorBody
  } catch {
    // A non-JSON error body (a proxy's 502 page, say) leaves the code empty.
  }
  const code = typeof body.error === 'string' ? body.error : ''
  const retryAfter = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined
  const detail = typeof body.detail === 'string' && body.detail !== '' ? body.detail : undefined
  return new ApiError(res.status, code, retryAfter, detail)
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, signal ? { signal } : {})
}

/**
 * Every state change goes through here so none can forget the content type.
 * That header is load-bearing: the server refuses a state-changing request that
 * is not `application/json`, as one of its CSRF layers (server/src/app.ts).
 */
export function sendJson<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** True for the one failure every authenticated screen has to handle itself. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

/**
 * The failure a screen with several requests in flight should act on. A 401
 * wins wherever it sits: it is the only one with an answer other than a
 * message, and a network blip on a side request must not hide it.
 */
export function firstFailure(...errors: unknown[]): unknown {
  return errors.find(isUnauthorized) ?? errors.find((error) => error !== undefined)
}
