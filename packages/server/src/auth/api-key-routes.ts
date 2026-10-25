import { Hono } from 'hono'
import type { Db } from '../db/index.ts'
import { readJsonBody } from '../json-body.ts'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKeyName,
  type ApiKeyRecord,
} from './api-keys.ts'
import { currentUser, type AuthEnv } from './middleware.ts'

export interface ApiKeyRoutesDeps {
  db: Db
}

interface ApiKeyResponse {
  id: number
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
}

function toResponse(record: ApiKeyRecord): ApiKeyResponse {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  }
}

export function createApiKeyRoutes(deps: ApiKeyRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  // Open to any credential acting for the user, agents included — ADR-0007.
  // Every key is the user's own: listed, minted and revoked for them alone.
  routes.get('/', (c) => c.json({ keys: listApiKeys(deps.db, currentUser(c).id).map(toResponse) }))

  /**
   * The one response that carries the secret. It is not stored anywhere it
   * could be read back, so a caller that loses it has to create another — which
   * is the property the whole scheme rests on.
   */
  routes.post('/', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const name = validateApiKeyName(body['name'])
    if (name === undefined) return c.json({ error: 'invalid_name' }, 400)

    const created = createApiKey(deps.db, currentUser(c).id, name)
    return c.json({ key: toResponse(created.record), secret: created.key }, 201)
  })

  /**
   * Not idempotent on purpose: a second delete answering 404 is how a screen
   * finds out its list was stale, and there is nothing destructive about
   * saying so.
   */
  routes.delete('/:id', (c) => {
    const raw = c.req.param('id')
    if (!/^\d+$/.test(raw)) return c.json({ error: 'invalid_request' }, 400)
    const id = Number(raw)
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'invalid_request' }, 400)

    if (!revokeApiKey(deps.db, currentUser(c).id, id)) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true })
  })

  return routes
}
