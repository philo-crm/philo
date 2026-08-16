import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { resolveApiKey } from '../auth/api-keys.ts'
import { bearerToken } from '../auth/middleware.ts'
import { wwwAuthenticate } from '../oauth/metadata.ts'
import { resolveAccessToken } from '../oauth/tokens.ts'
import { createMcpServer, type McpServerDeps } from './tools.ts'

/**
 * Ceiling on a request body, matching the REST surface's. Every JSON-RPC call
 * this server takes is orders of magnitude smaller; an email template is the
 * largest thing that crosses it.
 */
export const MAX_MCP_BODY_BYTES = 64 * 1024

export type McpRoutesDeps = McpServerDeps

/**
 * The MCP surface — DESIGN.md (MCP surface): streamable HTTP at `/mcp`, over the
 * same service layer the REST routes call.
 *
 * Stateless: a server and a transport are built per request and closed with it.
 * That is what the SDK requires of a transport with no session id (reusing one
 * collides message ids between clients), and it suits a surface where every
 * call is a request and a response with nothing to stream in between.
 *
 * Three deliberate differences from `/api/v1`:
 *
 * - **Bearer only.** A `philo_` key authenticates; a session cookie does not,
 *   even though a browser would attach one. Nothing here is reached from the
 *   app, so accepting the cookie would only add a cross-origin surface that
 *   needs CSRF defences of its own — the bearer requirement is what removes it.
 * - **No standalone SSE.** Nothing on this server pushes, so `GET` is answered
 *   405 rather than left holding a stream open forever. MCP clients try the GET
 *   and carry on when it is refused.
 * - **JSON responses.** `enableJsonResponse` returns a POST's answer as a whole
 *   JSON body instead of a one-message SSE stream. Same content, and it means a
 *   response is fully built before the request ends, so the per-request server
 *   can be closed as soon as `handleRequest` resolves.
 */
export function createMcpRoutes(deps: McpRoutesDeps): Hono {
  const routes = new Hono()

  // Tool results carry lead data, so they must not sit in a shared cache — and
  // the 401 must not either, or a rotated key's refusal outlives the rotation.
  routes.use('/', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  routes.use(
    '/',
    bodyLimit({
      maxSize: MAX_MCP_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  )

  routes.post('/', async (c) => {
    const token = bearerToken(c.req.header('authorization'))
    const actor = token === undefined ? undefined : resolveActor(deps.db, token)
    if (actor === undefined) {
      // The `resource_metadata` hint is what sends an OAuth-demanding client off
      // to discover this instance's authorization server — RFC 9728 §5.1.
      c.header('WWW-Authenticate', wwwAuthenticate(deps.publicBaseUrl, token !== undefined))
      return c.json({ error: 'unauthorized' }, 401)
    }

    const server = createMcpServer(deps, actor)
    // No `sessionIdGenerator`, which is what puts the transport in stateless
    // mode. The SDK's own example writes it as an explicit `undefined`, which
    // `exactOptionalPropertyTypes` refuses; omitting the key is the same thing.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      await server.close()
    }
  })

  routes.all('/', (c) => {
    c.header('Allow', 'POST')
    return c.json({ error: 'method_not_allowed' }, 405)
  })

  return routes
}

/**
 * Who the timeline records for a bearer credential — DESIGN.md (Auth and
 * access) wants one identity per credential, so a lead moved by an agent is
 * distinguishable from one moved by a person, and an agent holding an API key
 * from one holding a connector's OAuth grant.
 *
 * Both token kinds start `philo_`; each lookup rejects the other's prefix
 * before it reaches the database.
 */
function resolveActor(db: McpRoutesDeps['db'], token: string): string | undefined {
  const key = resolveApiKey(db, token)
  if (key !== undefined) return `api_key:${key.id}`
  const grant = resolveAccessToken(db, token)
  if (grant !== undefined) return `oauth:${grant.clientId}`
  return undefined
}
