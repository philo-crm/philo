import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { readJsonBody } from '../json-body.ts'
import type { Result } from '../result.ts'
import {
  createStage,
  deleteStage,
  listStages,
  reorderStages,
  updateStage,
  type StageError,
  type StageRecord,
} from './service.ts'

export interface StageRoutesDeps {
  db: Db
}

/**
 * Service error codes to HTTP. A table rather than inline `if`s so a code added
 * to the service has exactly one place it can be forgotten, and TypeScript
 * points at it.
 */
const STAGE_STATUS: Record<StageError, ContentfulStatusCode> = {
  not_found: 404,
  invalid_name: 400,
  invalid_terminal: 400,
  invalid_order: 400,
  // The request was well-formed and the funnel's state is what refused it.
  stage_not_empty: 409,
  last_stage: 409,
  too_many_stages: 409,
  no_pipeline: 503,
}

function fail(c: Context, error: StageError) {
  return c.json({ error }, STAGE_STATUS[error])
}

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

function respondStage(c: Context, result: Result<StageRecord, StageError>) {
  return result.ok ? c.json({ stage: result.value }) : fail(c, result.error)
}

function respondList(c: Context, result: Result<StageRecord[], StageError>) {
  return result.ok ? c.json({ stages: result.value }) : fail(c, result.error)
}

export function createStageRoutes(deps: StageRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  routes.get('/', (c) => c.json({ stages: listStages(deps.db) }))

  routes.post('/', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = createStage(deps.db, body)
    return result.ok ? c.json({ stage: result.value }, 201) : fail(c, result.error)
  })

  /**
   * A named action rather than a PATCH on the collection, because it takes the
   * whole funnel at once — see reorderStages for why a partial order is refused.
   *
   * Nothing else answers POST under this router besides `/`, so it is not
   * competing with `/:id` for the path; keep it above them anyway, so adding a
   * `POST /:id/...` route later cannot quietly turn "reorder" into an id.
   */
  routes.post('/reorder', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    return respondList(c, reorderStages(deps.db, body['stageIds']))
  })

  routes.patch('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    return respondStage(c, updateStage(deps.db, id, body))
  })

  /**
   * Answers with the whole funnel rather than 204: a delete renumbers nothing
   * but does change what the board may show next, and one round trip is cheaper
   * than the refetch every caller would otherwise make.
   */
  routes.delete('/:id', (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    return respondList(c, deleteStage(deps.db, id))
  })

  return routes
}
