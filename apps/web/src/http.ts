import { ApiError, isUnauthorized } from '@philo/sdk'

export { ApiError, isUnauthorized }

/**
 * The failure a screen with several requests in flight should act on. A 401
 * wins wherever it sits: it is the only one with an answer other than a
 * message, and a network blip on a side request must not hide it.
 */
export function firstFailure(...errors: unknown[]): unknown {
  return errors.find(isUnauthorized) ?? errors.find((error) => error !== undefined)
}

/**
 * The browser, not the server, refused to subscribe — no push service, a
 * profile that blocks it, a key it would not take. `name` and `message` are the
 * browser's own, because they are the only clue to which of those it was.
 */
export class PushSubscribeError extends Error {
  readonly reason: string

  constructor(cause: unknown) {
    // Read off the object rather than gated on `instanceof Error`: a
    // `DOMException` is not one everywhere, and it is the usual cause.
    const { name, message } = (cause ?? {}) as { name?: unknown; message?: unknown }
    super(typeof message === 'string' ? message : String(cause), { cause })
    this.name = 'PushSubscribeError'
    this.reason = typeof name === 'string' ? name : 'Error'
  }
}
