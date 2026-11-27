import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { readJsonBody } from '../json-body.ts'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKeyName,
  type ApiKeyRecord,
} from './api-keys.ts'
import { ACCOUNT_COLUMNS } from './access.ts'
import type { ExternalIdp } from './external-idp.ts'
import { adminRequired, currentUser, principalRole, type AuthEnv } from './middleware.ts'

export interface ApiKeyRoutesDeps {
  db: Db
  /** For the admin-scope challenge when a key is refused — ADR-0012. */
  externalIdp?: ExternalIdp | undefined
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

    // A key acts with its account's stored role, so minting one must not lift
    // a credential above what it holds — ADR-0012's "never more than the token
    // holds". Only an external token's scopes can sit below the stored role:
    // an admin's agent with the user scope alone is refused, and is told which
    // scope to ask for.
    const userId = currentUser(c).id
    const stored = deps.db.select(ACCOUNT_COLUMNS).from(users).where(eq(users.id, userId)).all()[0]?.role
    if (stored === 'admin' && principalRole(c) !== 'admin') return adminRequired(c, deps.externalIdp)

    const created = createApiKey(deps.db, userId, name)
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
