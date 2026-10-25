import { Hono } from 'hono'
import { currentUser, requireUser, type AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { readJsonBody } from '../json-body.ts'
import { deleteSubscription, saveSubscription, validateSubscription } from './subscriptions.ts'

export interface PushRoutesDeps {
  db: Db
  /**
   * The VAPID public key the browser needs as `applicationServerKey`. Public by
   * construction — it is what the push service verifies our signature against.
   */
  vapidPublicKey: string
}

export function createPushRoutes(deps: PushRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  // Session-only, all of it. A push subscription belongs to a browser and to
  // the person signed into it; an API key has neither.
  routes.use('/*', requireUser)

  /**
   * What the settings toggle subscribes with. Behind the session like everything
   * else under the API prefix — not because the key is a secret, but because
   * nothing on this instance is readable without signing in.
   */
  routes.get('/key', (c) => c.json({ publicKey: deps.vapidPublicKey }))

  routes.post('/subscriptions', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const validated = validateSubscription(body)
    if (!validated.ok) return c.json({ error: validated.error }, 400)

    saveSubscription(deps.db, currentUser(c).id, validated.value)
    // Nothing to hand back: the browser already holds the subscription, and the
    // row is keyed on the endpoint it just sent.
    return c.json({ ok: true }, 201)
  })

  /**
   * Idempotent: an endpoint that is not stored is the state the caller asked
   * for. A browser that dropped its subscription while the app was closed would
   * otherwise get an error for reporting the truth.
   */
  routes.delete('/subscriptions', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)

    const endpoint = body['endpoint']
    if (typeof endpoint !== 'string' || endpoint === '') {
      return c.json({ error: 'invalid_subscription' }, 400)
    }

    deleteSubscription(deps.db, endpoint)
    return c.json({ ok: true })
  })

  return routes
}
