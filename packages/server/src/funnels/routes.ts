import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import type { ChangeFeed } from '../events/feed.ts'
import { readJsonBody } from '../json-body.ts'
import type { Result } from '../result.ts'
import {
  createFunnel,
  deleteFunnel,
  getFunnel,
  listFunnels,
  parseFunnelParam,
  updateFunnel,
  type FunnelError,
  type FunnelRecord,
} from './service.ts'

export interface FunnelRoutesDeps {
  db: Db
  /** Where intake is served, so each form can be listed with the URL a website posts to. */
  publicBaseUrl: string
  /** Told when a funnel is renamed, created or deleted — ADR-0010. */
  changes: ChangeFeed
}

const FUNNEL_STATUS: Record<FunnelError, ContentfulStatusCode> = {
  not_found: 404,
  invalid_name: 400,
  invalid_from_name: 400,
  invalid_reply_to: 400,
  invalid_notify_recipients: 400,
  // The request was well-formed and the instance's state is what refused it.
  too_many_funnels: 409,
  funnel_not_empty: 409,
  last_funnel: 409,
}

function fail(c: Context, error: FunnelError) {
  return c.json({ error }, FUNNEL_STATUS[error])
}

/** Without trailing slashes. A loop, not `/\/+$/`, which backtracks on a long run of them. */
function trimTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end -= 1
  return url.slice(0, end)
}

/** A funnel as answered: each form with the public URL its website posts to. */
function present(funnel: FunnelRecord, base: string) {
  return {
    ...funnel,
    forms: funnel.forms.map((form) => ({ ...form, intakeUrl: `${base}/api/intake/${form.formKey}` })),
  }
}

/** Funnels — ADR-0009. Open to any credential acting for the user (ADR-0007). */
export function createFunnelRoutes(deps: FunnelRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()
  const base = trimTrailingSlashes(deps.publicBaseUrl)
  const one = (c: Context, result: Result<FunnelRecord, FunnelError>, status: ContentfulStatusCode = 200) =>
    result.ok ? c.json({ funnel: present(result.value, base) }, status) : fail(c, result.error)
  const all = (c: Context, funnels: FunnelRecord[]) =>
    c.json({ funnels: funnels.map((funnel) => present(funnel, base)) })

  routes.get('/', (c) => all(c, listFunnels(deps.db)))

  routes.post('/', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = createFunnel(deps.db, body)
    if (result.ok) deps.changes.publish('funnel.changed', result.value.id)
    return one(c, result, 201)
  })

  routes.get('/:id', (c) => {
    const id = parseFunnelParam(c.req.param('id'))
    if (id === null || id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const funnel = getFunnel(deps.db, id)
    return funnel === undefined ? fail(c, 'not_found') : one(c, { ok: true, value: funnel })
  })

  /** Patch semantics: a key left out keeps its value; `""` or `[]` clears an override. */
  routes.patch('/:id', async (c) => {
    const id = parseFunnelParam(c.req.param('id'))
    if (id === null || id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = updateFunnel(deps.db, id, body)
    if (result.ok) deps.changes.publish('funnel.changed', id)
    return one(c, result)
  })

  /** Answers with the remaining funnels — the default may have changed with it. */
  routes.delete('/:id', (c) => {
    const id = parseFunnelParam(c.req.param('id'))
    if (id === null || id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = deleteFunnel(deps.db, id)
    if (result.ok) deps.changes.publish('funnel.changed', id)
    return result.ok ? all(c, result.value) : fail(c, result.error)
  })

  return routes
}
