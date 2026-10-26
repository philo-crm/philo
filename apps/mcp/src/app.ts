import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createPhiloClient, isUnauthorized, MAX_ATTACHMENT_BYTES, type FetchLike } from '@philo/sdk'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { createMcpServer } from './tools.ts'

/**
 * Ceiling on a request body: one attachment at the API's own limit, base64'd
 * for `add_lead_attachment`, plus room for the JSON-RPC around it. Only an
 * authenticated caller gets this far — the token is checked before the body is
 * read — so an anonymous one cannot make the server buffer it.
 */
export const MAX_MCP_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64 * 1024

export const MCP_PATH = '/mcp'

/** RFC 9728 §3.1: the resource's path, appended to the well-known prefix. */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`

export interface McpAppOptions {
  /** Where the API is, e.g. `https://philo.example.com`. */
  apiBaseUrl: string
  /**
   * This endpoint's externally reachable URL — the RFC 8707 resource a
   * connector's token is issued for, and what its metadata names.
   */
  publicUrl: string
  /**
   * How the SDK reaches the API. Unset means the network; apps/standalone
   * passes the server's own `fetch`, so the call stays in-process while going
   * through exactly the HTTP handling a remote one would.
   */
  fetch?: FetchLike | undefined
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  // The scheme is case-insensitive per RFC 7235; the credential is not.
  return /^bearer\s+(\S+)$/i.exec(header.trim())?.[1]
}

/**
 * The agent UI — DESIGN.md (MCP surface), ADR-0006. An MCP server over
 * streamable HTTP that holds no credential and no data of its own: each
 * request's bearer token is forwarded to the API through the SDK, so the API
 * decides what the caller may do and records the caller on the timeline.
 *
 * Stateless: a server and a transport are built per request and closed with
 * it, which is what the MCP SDK requires of a transport with no session id.
 * JSON responses rather than SSE, and `GET` refused, because nothing here
 * streams.
 */
export function createMcpApp(options: McpAppOptions): Hono {
  const app = new Hono()
  const resourceMetadataUrl = `${new URL(options.publicUrl).origin}${PROTECTED_RESOURCE_METADATA_PATH}`
  const client = (token?: string) =>
    createPhiloClient({ baseUrl: options.apiBaseUrl, fetch: options.fetch, accessToken: () => token })

  /** RFC 6750 §3 with the RFC 9728 §5.1 hint that sends a client to discovery. */
  const challenge = (invalidToken: boolean) =>
    [
      'Bearer realm="philo"',
      ...(invalidToken ? ['error="invalid_token"'] : []),
      `resource_metadata="${resourceMetadataUrl}"`,
    ].join(', ')

  // Read by clients with no credential yet. The authorization server is
  // whatever issues the API's tokens — the built-in IdP or an external one —
  // so it is asked of the API rather than configured twice.
  app.use(PROTECTED_RESOURCE_METADATA_PATH, cors())
  app.get(PROTECTED_RESOURCE_METADATA_PATH, async (c) => {
    const { issuer } = await client().auth.config()
    return c.json({
      resource: options.publicUrl,
      authorization_servers: [issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_name: 'Philo',
    })
  })

  // Tool results carry lead data, so they must not sit in a shared cache — and
  // the 401 must not either, or a rotated key's refusal outlives the rotation.
  app.use(MCP_PATH, async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  /**
   * Checked before any MCP handling, so a dead token is an HTTP 401 the
   * client's OAuth machinery acts on — not a tool error inside a 200 — and
   * before the body limit, so nothing is read for a caller without one.
   */
  const authenticate: MiddlewareHandler = async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token === undefined) {
      c.header('WWW-Authenticate', challenge(false))
      return c.json({ error: 'unauthorized' }, 401)
    }
    try {
      await client(token).auth.principal()
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      c.header('WWW-Authenticate', challenge(true))
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  }

  const limitBody = bodyLimit({
    maxSize: MAX_MCP_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' }, 413),
  })

  app.post(MCP_PATH, authenticate, limitBody, async (c) => {
    const philo = client(bearerToken(c.req.header('authorization')))
    const server = createMcpServer(philo)
    // No `sessionIdGenerator`, which is what puts the transport in stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(c.req.raw)
    } finally {
      await server.close()
    }
  })

  app.all(MCP_PATH, (c) => {
    c.header('Allow', 'POST')
    return c.json({ error: 'method_not_allowed' }, 405)
  })

  return app
}
