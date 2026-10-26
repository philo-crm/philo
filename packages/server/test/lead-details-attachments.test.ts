import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { leadAttachmentBlobs, leads } from '../src/db/schema.ts'
import { MAX_ATTACHMENT_BYTES } from '../src/leads/attachments.ts'
import { MAX_DETAIL_KEY_LENGTH, MAX_DETAILS_BYTES } from '../src/leads/service.ts'
import { cleanupTestApps, createTestApp, defaultFormKey, setupAdmin, type TestApp } from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

interface AttachmentResponse {
  id: number
  filename: string
  contentType: string
  size: number
  sha256: string
  actor: string
}

interface LeadResponse {
  id: number
  fields: Record<string, unknown>
  details: Record<string, unknown>
  events: { type: string; payload: Record<string, unknown>; actor: string }[]
  attachments: AttachmentResponse[]
}

async function submit(testApp: TestApp, payload: Record<string, unknown>): Promise<number> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status !== 201) throw new Error(`intake failed: ${res.status} ${await res.text()}`)
  const [lead] = testApp.db.select({ id: leads.id }).from(leads).all().toReversed()
  return lead!.id
}

async function setup() {
  const testApp = createTestApp()
  const authorization = await setupAdmin(testApp)
  const id = await submit(testApp, { name: 'Dana Rivers', email: 'dana@example.com' })
  return { testApp, authorization, id }
}

function patch(testApp: TestApp, authorization: string, id: number, body: unknown) {
  return testApp.app.request(`/api/v1/leads/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify(body),
  })
}

async function lead(res: Response): Promise<LeadResponse> {
  return ((await res.json()) as { lead: LeadResponse }).lead
}

function upload(
  testApp: TestApp,
  authorization: string | undefined,
  id: number,
  data: Uint8Array,
  filename: string | undefined,
  contentType = 'application/pdf',
) {
  const query = filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`
  return testApp.app.request(`/api/v1/leads/${id}/attachments${query}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...(authorization === undefined ? {} : { authorization }) },
    body: data,
  })
}

describe('PATCH /api/v1/leads/:id details', () => {
  it('merges keys, removes them with null, and records only which keys changed', async () => {
    const { testApp, authorization, id } = await setup()

    let res = await patch(testApp, authorization, id, { details: { ssn: '000-00-0000', start_date: 'May' } })
    expect(res.status).toBe(200)
    expect((await lead(res)).details).toEqual({ ssn: '000-00-0000', start_date: 'May' })

    res = await patch(testApp, authorization, id, { details: { ssn: null, start_date: 'June' } })
    const body = await lead(res)
    expect(body.details).toEqual({ start_date: 'June' })

    const changes = body.events.filter((event) => event.type === 'details_changed')
    expect(changes.map((event) => event.payload)).toEqual([
      { keys: ['ssn', 'start_date'] },
      { keys: ['ssn', 'start_date'] },
    ])
    expect(JSON.stringify(body.events)).not.toContain('000-00-0000')
    expect(changes[0]!.actor).toMatch(/^user:/)
  })

  it('writes no event when the patch changes nothing', async () => {
    const { testApp, authorization, id } = await setup()
    await patch(testApp, authorization, id, { details: { start_date: 'May' } })
    const body = await lead(await patch(testApp, authorization, id, { details: { start_date: 'May', gone: null } }))
    expect(body.events.filter((event) => event.type === 'details_changed')).toHaveLength(1)
  })

  it('stores a __proto__ key as data', async () => {
    const { testApp, authorization, id } = await setup()
    const res = await patch(testApp, authorization, id, JSON.parse('{"details":{"__proto__":{"polluted":true}}}'))
    expect(res.status).toBe(200)
    const row = testApp.db.select({ details: leads.details }).from(leads).all()[0]!
    expect(row.details).toBe('{"__proto__":{"polluted":true}}')
  })

  it('trims keys so one name cannot become two entries', async () => {
    const { testApp, authorization, id } = await setup()
    const body = await lead(await patch(testApp, authorization, id, { details: { ' start_date ': 'May' } }))
    expect(body.details).toEqual({ start_date: 'May' })
  })

  it.each([
    ['an array', ['x']],
    ['a string', 'x'],
    ['an empty key', { ' ': 'x' }],
    ['an over-long key', { ['k'.repeat(MAX_DETAIL_KEY_LENGTH + 1)]: 'x' }],
  ])('refuses %s', async (_label, details) => {
    const { testApp, authorization, id } = await setup()
    const res = await patch(testApp, authorization, id, { details })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_details' })
  })

  it('refuses a patch that would push the whole object past its ceiling', async () => {
    const { testApp, authorization, id } = await setup()
    const half = 'x'.repeat(MAX_DETAILS_BYTES / 2)
    expect((await patch(testApp, authorization, id, { details: { a: half } })).status).toBe(200)
    const res = await patch(testApp, authorization, id, { details: { b: half } })
    expect(res.status).toBe(400)
    const row = testApp.db.select({ details: leads.details }).from(leads).all()[0]!
    expect(Object.keys(JSON.parse(row.details) as object)).toEqual(['a'])
  })

  it('is searchable', async () => {
    const { testApp, authorization, id } = await setup()
    await patch(testApp, authorization, id, { details: { callback: 'Thursday afternoon' } })
    const res = await testApp.app.request('/api/v1/leads?search=thursday', { headers: { authorization } })
    await expect(res.json()).resolves.toMatchObject({ total: 1 })
  })

  it('is never written by intake', async () => {
    const testApp = createTestApp()
    const authorization = await setupAdmin(testApp)
    const id = await submit(testApp, { email: 'a@example.com', details: { sneaky: 'yes' } })
    const res = await testApp.app.request(`/api/v1/leads/${id}`, { headers: { authorization } })
    const body = await lead(res)
    expect(body.details).toEqual({})
    expect(body.fields).toEqual({ details: { sneaky: 'yes' } })
  })
})

describe('lead attachments', () => {
  it('stores an upload, lists it on the lead, and records it on the timeline', async () => {
    const { testApp, authorization, id } = await setup()
    const data = new TextEncoder().encode('%PDF-1.7 resume')

    const res = await upload(testApp, authorization, id, data, 'resume.pdf', 'application/pdf; charset=binary')
    expect(res.status).toBe(201)
    const body = await lead(res)
    expect(body.attachments).toEqual([
      expect.objectContaining({
        filename: 'resume.pdf',
        contentType: 'application/pdf',
        size: data.byteLength,
        sha256: createHash('sha256').update(data).digest('hex'),
      }),
    ])
    expect(body.events.at(-1)).toMatchObject({
      type: 'attachment_added',
      payload: { attachmentId: body.attachments[0]!.id, filename: 'resume.pdf', size: data.byteLength },
    })
  })

  it('serves a download that cannot render as a page', async () => {
    const { testApp, authorization, id } = await setup()
    const data = new TextEncoder().encode('<script>alert(1)</script>')
    const added = await lead(await upload(testApp, authorization, id, data, 'C:\\Users\\x\\Résumé "final".html', 'text/html'))
    const attachment = added.attachments[0]!
    expect(attachment.filename).toBe('Résumé "final".html')

    const res = await testApp.app.request(`/api/v1/leads/${id}/attachments/${attachment.id}`, {
      headers: { authorization },
    })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data)
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="R_sum_ _final_.html"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.html`,
    )
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('falls back to a generic type for a malformed one', async () => {
    const { testApp, authorization, id } = await setup()
    const added = await lead(await upload(testApp, authorization, id, new Uint8Array([1]), 'a.bin', 'not a type'))
    expect(added.attachments[0]!.contentType).toBe('application/octet-stream')
  })

  it('takes files past the API-wide body limit, up to its own', async () => {
    const { testApp, authorization, id } = await setup()
    const res = await upload(testApp, authorization, id, new Uint8Array(200 * 1024).fill(7), 'scan.png', 'image/png')
    expect(res.status).toBe(201)
  })

  it('refuses a file over the limit and stores nothing', async () => {
    const { testApp, authorization, id } = await setup()
    const res = await upload(testApp, authorization, id, new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'big.bin')
    expect(res.status).toBe(413)
    expect(testApp.db.select().from(leadAttachmentBlobs).all()).toHaveLength(0)
  })

  it.each([
    ['an empty file', new Uint8Array(0), 'a.txt'],
    ['no filename', new Uint8Array([1]), undefined],
    ['a blank filename', new Uint8Array([1]), '  '],
    ['a control character in the name', new Uint8Array([1]), 'a\r\nb.txt'],
  ])('refuses %s', async (_label, data, filename) => {
    const { testApp, authorization, id } = await setup()
    const res = await upload(testApp, authorization, id, data, filename)
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'invalid_attachment' })
  })

  it('requires a credential before reading the body', async () => {
    const { testApp, id } = await setup()
    const res = await upload(testApp, undefined, id, new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'big.bin')
    expect(res.status).toBe(401)
  })

  it('404s an unknown lead', async () => {
    const { testApp, authorization } = await setup()
    const res = await upload(testApp, authorization, 9999, new Uint8Array([1]), 'a.txt')
    expect(res.status).toBe(404)
  })

  it('removes the file and its bytes, and records the removal', async () => {
    const { testApp, authorization, id } = await setup()
    const added = await lead(await upload(testApp, authorization, id, new Uint8Array([1, 2]), 'a.txt', 'text/plain'))
    const attachmentId = added.attachments[0]!.id
    const path = `/api/v1/leads/${id}/attachments/${attachmentId}`

    const res = await testApp.app.request(path, { method: 'DELETE', headers: { authorization } })
    expect(res.status).toBe(200)
    const body = await lead(res)
    expect(body.attachments).toEqual([])
    expect(body.events.at(-1)).toMatchObject({
      type: 'attachment_removed',
      payload: { attachmentId, filename: 'a.txt', size: 2 },
    })
    expect(testApp.db.select().from(leadAttachmentBlobs).all()).toHaveLength(0)

    expect((await testApp.app.request(path, { method: 'DELETE', headers: { authorization } })).status).toBe(404)
    expect((await testApp.app.request(path, { headers: { authorization } })).status).toBe(404)
  })

  it('does not reach another lead’s file through this lead’s path', async () => {
    const { testApp, authorization, id } = await setup()
    const other = await submit(testApp, { email: 'other@example.com' })
    const added = await lead(await upload(testApp, authorization, id, new Uint8Array([1]), 'a.txt'))
    const path = `/api/v1/leads/${other}/attachments/${added.attachments[0]!.id}`
    expect((await testApp.app.request(path, { headers: { authorization } })).status).toBe(404)
    expect((await testApp.app.request(path, { method: 'DELETE', headers: { authorization } })).status).toBe(404)
  })
})
