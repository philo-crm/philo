/**
 * What the service layer answers with. Errors are codes, not HTTP statuses:
 * REST and the future MCP surface (#15) call the same functions and map the
 * code to whatever their own protocol says, so a service that returned a 404
 * would have already made that choice for both of them.
 */
export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

export function err<E extends string>(error: E): { ok: false; error: E } {
  return { ok: false, error }
}
