import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { actorOf, type AuthEnv } from '../auth/middleware.ts'
import type { Db } from '../db/index.ts'
import { readJsonBody } from '../json-body.ts'
import { notifyLeadCreated, type LeadCreatedHook } from '../notify.ts'
import {
  addLeadNote,
  clearLeadSpam,
  getLead,
  listLeads,
  moveLeadStage,
  updateLeadContact,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type LeadDetail,
  type LeadError,
  type ListLeadsFilters,
} from './service.ts'
import { err, ok, type Result } from '../result.ts'

export interface LeadRoutesDeps {
  db: Db
  /** Re-fired when a quarantined lead is promoted — see clearLeadSpam. */
  onLeadCreated?: LeadCreatedHook | undefined
}

/**
 * Service error codes to HTTP. Kept as a table rather than inline `if`s so a
 * code added to the service has exactly one place it can be forgotten, and
 * TypeScript points at it.
 */
const LEAD_STATUS: Record<LeadError, ContentfulStatusCode> = {
  not_found: 404,
  invalid_stage: 422,
  invalid_note: 400,
  invalid_contact: 400,
  email_or_phone_required: 422,
}

function fail(c: Context, error: LeadError) {
  return c.json({ error }, LEAD_STATUS[error])
}

function parseId(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

function parsePositiveInt(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined
  const value = parseId(raw)
  return value ?? 'invalid'
}

function parseBoolean(raw: string | undefined): boolean | undefined | 'invalid' {
  if (raw === undefined) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  return 'invalid'
}

function parseDate(raw: string | undefined): Date | undefined | 'invalid' {
  if (raw === undefined) return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? 'invalid' : date
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) return 'invalid' as const
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) return 'invalid' as const
  return value
}

/**
 * Every query parameter, validated together. A filter whose value does not
 * parse is a 400 rather than a filter silently dropped — a list that quietly
 * widened itself is how a quarantined lead ends up in the funnel view.
 */
function parseListQuery(c: Context): Result<ListLeadsFilters, 'invalid_request'> {
  const query = c.req.query()
  const stageId = parsePositiveInt(query['stage'])
  const formId = parsePositiveInt(query['form'])
  const isSpam = parseBoolean(query['spam'])
  const createdAfter = parseDate(query['createdAfter'])
  const createdBefore = parseDate(query['createdBefore'])
  const limit = parseBoundedInt(query['limit'], DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE)
  const offset = parseBoundedInt(query['offset'], 0, 0, Number.MAX_SAFE_INTEGER)

  if (
    stageId === 'invalid' ||
    formId === 'invalid' ||
    isSpam === 'invalid' ||
    createdAfter === 'invalid' ||
    createdBefore === 'invalid' ||
    limit === 'invalid' ||
    offset === 'invalid'
  ) {
    return err('invalid_request')
  }

  return ok({
    stageId,
    formId,
    isSpam: isSpam ?? false,
    search: query['search'],
    createdAfter,
    createdBefore,
    limit,
    offset,
  })
}

function respond(c: Context, result: Result<LeadDetail, LeadError>) {
  return result.ok ? c.json({ lead: result.value }) : fail(c, result.error)
}

export function createLeadRoutes(deps: LeadRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()

  routes.get('/', (c) => {
    const filters = parseListQuery(c)
    if (!filters.ok) return c.json({ error: filters.error }, 400)
    return c.json(listLeads(deps.db, filters.value))
  })

  routes.get('/:id', (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const lead = getLead(deps.db, id)
    if (lead === undefined) return fail(c, 'not_found')
    return c.json({ lead })
  })

  routes.patch('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    return respond(c, updateLeadContact(deps.db, id, body))
  })

  routes.post('/:id/stage', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    return respond(c, moveLeadStage(deps.db, id, body['stageId'], actorOf(c)))
  })

  routes.post('/:id/notes', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    return respond(c, addLeadNote(deps.db, id, body['note'], actorOf(c)))
  })

  /**
   * The spam view's "not spam" action. DESIGN.md (Intake endpoint): promoting a
   * quarantined lead fires the pipeline that was suppressed when it arrived —
   * and only on the call that actually promotes it, so a double click cannot
   * send the acknowledgment twice.
   */
  routes.post('/:id/not-spam', (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = clearLeadSpam(deps.db, id, actorOf(c))
    if (!result.ok) return fail(c, result.error)

    const { lead, promoted, formId } = result.value
    if (promoted) {
      notifyLeadCreated(deps.onLeadCreated, { id: lead.id, formId, isSpam: false })
    }
    return c.json({ lead })
  })

  return routes
}
