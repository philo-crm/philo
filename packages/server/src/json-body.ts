import type { Context } from 'hono'

/**
 * The request's JSON object, or undefined for anything that is not one.
 *
 * The content-type check is belt to the middleware's braces — app.ts rejects a
 * non-JSON state change before any handler runs, and that is where the CSRF
 * reasoning lives. This only has to turn a malformed body into a 400.
 *
 * Arrays and `null` are rejected alongside malformed bytes: every body this API
 * takes is an object, and letting an array through would have each handler
 * discover that for itself.
 */
export async function readJsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) return undefined
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}
