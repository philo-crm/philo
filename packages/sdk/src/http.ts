/**
 * The API answers every error as `{ error: "<code>" }`, so a caller only ever
 * looks at `status` and `code`. The human sentence is the caller's business,
 * because the same code reads differently on a login screen and on a lead.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Sent by the throttled endpoints. */
  readonly retryAfterSeconds: number | undefined
  /**
   * A sentence from something the server was talking to, when the code alone
   * cannot say what went wrong — the SMTP test-send, or a template Handlebars
   * refused.
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

/** True for the one failure every authenticated caller has to handle itself. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

export type FetchLike = (input: string, init?: RequestInit) => Response | Promise<Response>

/** Where a bearer token comes from. Undefined means "send the request without one". */
export type AccessTokenSource = () => string | undefined | Promise<string | undefined>

export interface TransportOptions {
  /** The server's origin, e.g. `https://philo.example.com`. Empty for same-origin. */
  baseUrl?: string | undefined
  /**
   * Defaults to the global `fetch`, looked up per call so a test that stubs it
   * after the client was built still takes effect. A host that runs the server
   * in-process passes the app's own `fetch` here.
   */
  fetch?: FetchLike | undefined
  accessToken?: AccessTokenSource | undefined
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

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export class Transport {
  readonly #options: TransportOptions

  constructor(options: TransportOptions = {}) {
    this.#options = options
  }

  get baseUrl(): string {
    return (this.#options.baseUrl ?? '').replace(/\/+$/, '')
  }

  async request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = await this.#options.accessToken?.()
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`
    const init: RequestInit = { method, headers }
    if (method !== 'GET') {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body ?? {})
    }
    if (signal !== undefined) init.signal = signal

    const fetchImpl = this.#options.fetch ?? ((input, requestInit) => fetch(input, requestInit))
    const res = await fetchImpl(`${this.baseUrl}${path}`, init)
    if (!res.ok) throw await toApiError(res)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }
}
