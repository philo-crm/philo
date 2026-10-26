import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { actorOf, type AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { readJsonBody } from '../json-body.ts'
import { sendTestDelivery, type DeliveryTuning } from './deliver.ts'
import {
  createWebhook,
  deleteWebhook,
  findWebhookTarget,
  listWebhooks,
  updateWebhook,
  type WebhookError,
} from './service.ts'

export interface WebhookRoutesDeps {
  db: Db
  deliveryTuning?: DeliveryTuning | undefined
}

const WEBHOOK_STATUS: Record<WebhookError, ContentfulStatusCode> = {
  not_found: 404,
  invalid_url: 400,
  invalid_events: 400,
  invalid_auth_header: 400,
  invalid_funnel: 422,
  too_many_webhooks: 409,
}

function fail(c: Context, error: WebhookError) {
  return c.json({ error }, WEBHOOK_STATUS[error])
}

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** Webhooks — ADR-0010. Open to any credential acting for the user (ADR-0007). */
export function createWebhookRoutes(deps: WebhookRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  routes.get('/', (c) => c.json({ webhooks: listWebhooks(deps.db) }))

  /** The one answer that carries the signing secret. */
  routes.post('/', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = createWebhook(deps.db, body, actorOf(c))
    return result.ok ? c.json(result.value, 201) : fail(c, result.error)
  })

  /** Only the auth header changes; a new URL or scope is a new registration. */
  routes.patch('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = updateWebhook(deps.db, id, body)
    return result.ok ? c.json({ webhook: result.value }) : fail(c, result.error)
  })

  routes.delete('/:id', (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    return deleteWebhook(deps.db, id) ? c.body(null, 204) : fail(c, 'not_found')
  })

  /** Sends a `ping` now and answers with how the receiver took it — a failed one is still a 200. */
  routes.post('/:id/test', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const target = findWebhookTarget(deps.db, id)
    if (target === undefined) return fail(c, 'not_found')
    return c.json({ delivery: await sendTestDelivery(deps.db, target, deps.deliveryTuning) })
  })

  return routes
}
