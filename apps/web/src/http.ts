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
