import { asc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { leads, stages } from '../src/db/schema.ts'
import { DEFAULT_STAGES } from '../src/db/seed.ts'
import { MAX_STAGE_NAME_LENGTH, MAX_STAGES } from '../src/stages/service.ts'
import {
  cleanupTestApps,
  createTestApp,
  jsonPost,
  setupAdmin,
  TEST_ORIGIN,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

interface StageResponse {
  id: number
  name: string
  position: number
  isTerminal: boolean
  leadCount: number
}

function jsonRequest(method: string, body: unknown, cookie: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

async function listStages(testApp: TestApp, cookie: string): Promise<StageResponse[]> {
  const res = await testApp.app.request('/api/v1/stages', { headers: { cookie } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { stages: StageResponse[] }
  return body.stages
}

/** A lead parked in a stage, so the delete-if-empty and count paths have something real. */
function seedLead(testApp: TestApp, stageId: number, isSpam = false): number {
  const [lead] = testApp.db
    .insert(leads)
    .values({ name: 'Dana Rivers', email: 'dana@example.com', currentStageId: stageId, isSpam })
    .returning({ id: leads.id })
    .all()
  if (lead === undefined) throw new Error('failed to seed a lead')
  return lead.id
}

describe('GET /api/v1/stages', () => {
  it('returns the seeded funnel in order, with lead counts', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)

    expect(listed.map((stage) => stage.name)).toEqual(DEFAULT_STAGES.map((stage) => stage.name))
    expect(listed.map((stage) => stage.position)).toEqual([0, 1, 2, 3])
    expect(listed.at(-1)?.isTerminal).toBe(true)
    expect(listed.every((stage) => stage.leadCount === 0)).toBe(true)
  })

  it('counts quarantined leads too, so an empty count means deletable', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [first] = await listStages(testApp, cookie)
    seedLead(testApp, first?.id ?? 0, true)

    const listed = await listStages(testApp, cookie)
    expect(listed[0]?.leadCount).toBe(1)
  })

  it('requires a session', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/api/v1/stages')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/stages', () => {
  it('appends a stage to the end of the funnel', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)

    const res = await testApp.app.request(
      '/api/v1/stages',
      jsonPost({ name: '  Screening  ' }, { cookie }),
    )
    expect(res.status).toBe(201)
    const created = (await res.json()) as { stage: StageResponse }
    expect(created.stage).toMatchObject({ name: 'Screening', position: 4, isTerminal: false, leadCount: 0 })

    const listed = await listStages(testApp, cookie)
    expect(listed.at(-1)?.name).toBe('Screening')
  })

  it('accepts a terminal stage', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request(
      '/api/v1/stages',
      jsonPost({ name: 'Rejected', isTerminal: true }, { cookie }),
    )
    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toMatchObject({ stage: { isTerminal: true } })
  })

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['a non-string name', { name: 42 }],
    ['an over-long name', { name: 'x'.repeat(MAX_STAGE_NAME_LENGTH + 1) }],
  ])('rejects %s', async (_label, body) => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/stages', jsonPost(body, { cookie }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_name' })
  })

  it('rejects a non-boolean isTerminal rather than coercing it', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request(
      '/api/v1/stages',
      jsonPost({ name: 'Screening', isTerminal: 'yes' }, { cookie }),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_terminal' })
  })

  it('refuses to grow the funnel past the ceiling', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [pipeline] = testApp.db.select({ id: stages.pipelineId }).from(stages).limit(1).all()
    const existing = testApp.db.select({ id: stages.id }).from(stages).all().length
    testApp.db
      .insert(stages)
      .values(
        Array.from({ length: MAX_STAGES - existing }, (_unused, index) => ({
          pipelineId: pipeline?.id ?? 0,
          name: `Filler ${index}`,
          position: existing + index,
        })),
      )
      .run()

    const res = await testApp.app.request('/api/v1/stages', jsonPost({ name: 'One too many' }, { cookie }))
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'too_many_stages' })
  })
})

describe('PATCH /api/v1/stages/:id', () => {
  it('renames a stage', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [first] = await listStages(testApp, cookie)

    const res = await testApp.app.request(
      `/api/v1/stages/${first?.id}`,
      jsonRequest('PATCH', { name: 'Applied' }, cookie),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ stage: { id: first?.id, name: 'Applied' } })
  })

  it('flips the terminal flag', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)
    const terminal = listed.at(-1)

    const res = await testApp.app.request(
      `/api/v1/stages/${terminal?.id}`,
      jsonRequest('PATCH', { isTerminal: false }, cookie),
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ stage: { isTerminal: false } })
  })

  it('404s an unknown stage', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request(
      '/api/v1/stages/9999',
      jsonRequest('PATCH', { name: 'Nope' }, cookie),
    )
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'not_found' })
  })

  it('rejects a blank rename', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const [first] = await listStages(testApp, cookie)
    const res = await testApp.app.request(
      `/api/v1/stages/${first?.id}`,
      jsonRequest('PATCH', { name: '' }, cookie),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_name' })
  })
})

describe('POST /api/v1/stages/reorder', () => {
  it('applies a new order and renumbers positions from zero', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)
    const reversed = listed.toReversed().map((stage) => stage.id)

    const res = await testApp.app.request('/api/v1/stages/reorder', jsonPost({ stageIds: reversed }, { cookie }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stages: StageResponse[] }
    expect(body.stages.map((stage) => stage.id)).toEqual(reversed)
    expect(body.stages.map((stage) => stage.position)).toEqual([0, 1, 2, 3])

    const persisted = testApp.db
      .select({ id: stages.id })
      .from(stages)
      .orderBy(asc(stages.position))
      .all()
    expect(persisted.map((stage) => stage.id)).toEqual(reversed)
  })

  it.each([
    ['a partial list', (ids: number[]) => ids.slice(0, 2)],
    ['a duplicated id', (ids: number[]) => [ids[0] ?? 0, ...ids.slice(0, ids.length - 1)]],
    ['an unknown id', (ids: number[]) => [...ids.slice(1), 9999]],
  ])('rejects %s without touching the order', async (_label, mangle) => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const before = await listStages(testApp, cookie)
    const ids = before.map((stage) => stage.id)

    const res = await testApp.app.request(
      '/api/v1/stages/reorder',
      jsonPost({ stageIds: mangle(ids) }, { cookie }),
    )
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_order' })
    expect((await listStages(testApp, cookie)).map((stage) => stage.id)).toEqual(ids)
  })

  it('rejects a non-array payload', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/stages/reorder', jsonPost({ stageIds: 'all' }, { cookie }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_order' })
  })
})

describe('DELETE /api/v1/stages/:id', () => {
  it('deletes an empty stage and returns the remaining funnel', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)
    const doomed = listed[1]

    const res = await testApp.app.request(
      `/api/v1/stages/${doomed?.id}`,
      jsonRequest('DELETE', undefined, cookie),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { stages: StageResponse[] }
    expect(body.stages.map((stage) => stage.id)).not.toContain(doomed?.id)
    expect(testApp.db.select({ id: stages.id }).from(stages).where(eq(stages.id, doomed?.id ?? 0)).all()).toEqual([])
  })

  it('refuses a stage that still holds a lead', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)
    seedLead(testApp, listed[1]?.id ?? 0)

    const res = await testApp.app.request(
      `/api/v1/stages/${listed[1]?.id}`,
      jsonRequest('DELETE', undefined, cookie),
    )
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'stage_not_empty' })
  })

  it('refuses a quarantined lead as an occupant too', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)
    seedLead(testApp, listed[1]?.id ?? 0, true)

    const res = await testApp.app.request(
      `/api/v1/stages/${listed[1]?.id}`,
      jsonRequest('DELETE', undefined, cookie),
    )
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'stage_not_empty' })
  })

  it('keeps the last stage, so intake always has somewhere to file', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const listed = await listStages(testApp, cookie)

    for (const stage of listed.slice(1)) {
      const res = await testApp.app.request(
        `/api/v1/stages/${stage.id}`,
        jsonRequest('DELETE', undefined, cookie),
      )
      expect(res.status).toBe(200)
    }

    const last = await listStages(testApp, cookie)
    expect(last).toHaveLength(1)
    const res = await testApp.app.request(
      `/api/v1/stages/${last[0]?.id}`,
      jsonRequest('DELETE', undefined, cookie),
    )
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({ error: 'last_stage' })
  })

  it('404s an unknown stage', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/api/v1/stages/9999', jsonRequest('DELETE', undefined, cookie))
    expect(res.status).toBe(404)
  })
})
