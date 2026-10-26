import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiKey, revokeApiKey } from '../../../packages/server/src/auth/api-keys.ts'
import { leadEvents, leads, stages, users } from '../../../packages/server/src/db/schema.ts'
import { sweepUnsentEmails } from '../../../packages/server/src/email/service.ts'
import { getEmailTemplate } from '../../../packages/server/src/email/templates.ts'
import { HONEYPOT_FIELD, MAX_FIELD_DEPTH } from '../../../packages/server/src/intake/payload.ts'
import type { CreatedLead } from '../../../packages/server/src/notify.ts'
import {
  cleanupTestApps,
  configureEmail,
  createTestApp as createServerTestApp,
  defaultFormKey,
  operatorAuth,
  recordingSender,
  setupAdmin,
  withServer,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from '../../../packages/server/test/support/app.ts'
import { createMcpApp, MAX_MCP_BODY_BYTES } from '../src/app.ts'

afterEach(() => {
  cleanupTestApps()
})

/**
 * The server and the MCP app composed the way apps/standalone composes them:
 * MCP's paths to the MCP app, everything else to the server, and the MCP app
 * reaching the API in-process through the server's own request handling. So
 * every call here crosses the real API boundary, auth included.
 */
function createTestApp(options: Parameters<typeof createServerTestApp>[0] = {}): TestApp {
  const server = createServerTestApp(options)
  const mcp = createMcpApp({
    apiBaseUrl: TEST_PUBLIC_BASE_URL,
    publicUrl: `${TEST_PUBLIC_BASE_URL}/mcp`,
    fetch: (input, init) => server.app.request(input, init),
  })
  const app = new Hono()
  app.route('/', mcp)
  app.route('/', server.app)
  return { ...server, app: app as unknown as TestApp['app'] }
}

/** Every tool DESIGN.md (MCP surface) names, with the funnel tools of ADR-0009. */
const TOOL_NAMES = [
  'add_lead_attachment',
  'add_lead_note',
  'create_funnel',
  'create_lead',
  'create_stage',
  'delete_funnel',
  'delete_lead',
  'delete_stage',
  'get_email_template',
  'get_lead',
  'get_lead_attachment',
  'list_email_templates',
  'list_funnels',
  'list_leads',
  'list_stages',
  'move_lead_stage',
  'preview_email_template',
  'remove_lead_attachment',
  'reorder_stages',
  'update_email_template',
  'update_funnel',
  'update_lead',
  'update_stage',
]

interface ToolAnswer {
  isError: boolean
  data: Record<string, unknown>
}

/** Through the real intake endpoint, so `fields` and the FTS index are real. */
async function submit(testApp: TestApp, payload: Record<string, unknown>): Promise<void> {
  const res = await testApp.app.request(`/api/intake/${defaultFormKey(testApp)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status !== 201) throw new Error(`intake failed: ${res.status} ${await res.text()}`)
}

/**
 * A real MCP client over a real socket, which is the acceptance criterion on
 * #15 — the SDK's own transport decides whether the wire format is right, and
 * an assertion against a hand-built JSON-RPC body would not.
 */
async function withMcpClient<T>(
  testApp: TestApp,
  key: string,
  body: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolAnswer>, client: Client) => Promise<T>,
): Promise<T> {
  return withServer(testApp, async (baseUrl) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    })
    const client = new Client({ name: 'philo-tests', version: '0' })
    // The client transport exposes `sessionId` as a getter typed
    // `string | undefined`, which `exactOptionalPropertyTypes` refuses for the
    // interface's optional `sessionId?: string`. An SDK typing gap and nothing
    // more — the server transport declares the same name as a field and passes.
    await client.connect(transport as unknown as Transport)
    try {
      return await body(async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args })
        const [first] = result.content as { type: string; text: string }[]
        if (first?.type !== 'text') throw new Error(`${name} answered with no text content`)
        return { isError: result.isError === true, data: JSON.parse(first.text) as Record<string, unknown> }
      }, client)
    } finally {
      await client.close()
    }
  })
}

/**
 * An API key for the instance's account, created if there is none yet. A key
 * acts with its user's authority (ADR-0007), so every key needs one.
 */
function agentKey(testApp: TestApp): ReturnType<typeof createApiKey> {
  const [existing] = testApp.db.select({ id: users.id }).from(users).limit(1).all()
  const userId =
    existing?.id ??
    testApp.db.insert(users).values({ email: 'owner@example.com', passwordHash: 'unused', name: null }).returning({ id: users.id }).all()[0]?.id
  if (userId === undefined) throw new Error('no user to own the key')
  return createApiKey(testApp.db, userId, 'Agent')
}

function firstStageId(testApp: TestApp): number {
  const [stage] = testApp.db
    .select({ id: stages.id })
    .from(stages)
    .orderBy(asc(stages.position), asc(stages.id))
    .limit(1)
    .all()
  if (stage === undefined) throw new Error('no stage was seeded')
  return stage.id
}

function jsonRpcPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
}

describe('mcp transport', () => {
  /** RFC 9728 §5.1 — what sends an OAuth client off to discover the AS. */
  const RESOURCE_METADATA = `resource_metadata="${TEST_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp"`

  it('refuses a request with no credential and asks for a bearer one', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE))

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(`Bearer realm="philo", ${RESOURCE_METADATA}`)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('names the credential as the problem when one was presented', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/mcp',
      jsonRpcPost(INITIALIZE, { authorization: 'Bearer philo_not-a-real-key' }),
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer realm="philo", error="invalid_token", ${RESOURCE_METADATA}`,
    )
  })

  it('stops accepting a key the moment it is revoked', async () => {
    const testApp = createTestApp()
    const { key, record } = agentKey(testApp)
    const authorized = { authorization: `Bearer ${key}` }

    expect((await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE, authorized))).status).toBe(200)
    revokeApiKey(testApp.db, 1, record.id)

    // Revocation is a row delete and this surface holds nothing between
    // requests, so there is no cached session for a key to outlive itself in.
    const after = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE, authorized))
    expect(after.status).toBe(401)
  })

  it('does not accept a cookie in place of a token', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const res = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE, { cookie: 'philo_session=x' }))

    expect(res.status).toBe(401)
  })

  it('names the API\'s issuer in its protected-resource metadata', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/.well-known/oauth-protected-resource/mcp')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      resource: `${TEST_PUBLIC_BASE_URL}/mcp`,
      authorization_servers: [TEST_PUBLIC_BASE_URL],
      bearer_methods_supported: ['header'],
    })
  })

  it('forwards an operator token too, and the timeline records the person', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const operator = operatorAuth(testApp, 1).replace(/^Bearer /, '')

    await withMcpClient(testApp, operator, async (call) => {
      const created = await call('create_lead', { name: 'Pat', email: 'pat@example.com' })
      expect(created.isError).toBe(false)
    })
    const [event] = testApp.db.select().from(leadEvents).where(eq(leadEvents.type, 'created')).all()
    expect(event?.actor).toBe('user:1')
  })

  it('answers GET with 405 rather than holding a stream open', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    const res = await testApp.app.request('/mcp', {
      headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' },
    })

    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })

  it('bounds the request body', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    const oversized = {
      ...INITIALIZE,
      params: { ...INITIALIZE.params, padding: 'x'.repeat(MAX_MCP_BODY_BYTES) },
    }
    const res = await testApp.app.request(
      '/mcp',
      jsonRpcPost(oversized, { authorization: `Bearer ${key}` }),
    )

    expect(res.status).toBe(413)
  })

  it('turns away an oversized body without a credential before reading it', async () => {
    const testApp = createTestApp()
    const oversized = {
      ...INITIALIZE,
      params: { ...INITIALIZE.params, padding: 'x'.repeat(MAX_MCP_BODY_BYTES) },
    }
    const res = await testApp.app.request('/mcp', jsonRpcPost(oversized))

    expect(res.status).toBe(401)
  })

  it('keeps answers out of shared caches', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE))

    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('serves every MVP tool', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    const names = await withMcpClient(testApp, key, async (_call, client) => {
      const { tools } = await client.listTools()
      return tools.map((tool) => tool.name).toSorted()
    })

    expect(names).toEqual(TOOL_NAMES)
  })
})

describe('mcp lead tools', () => {
  it('searches, reads and advances a lead end to end', async () => {
    const testApp = createTestApp()
    const { key, record } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com', endorsements: 'Hazmat' })
    await submit(testApp, { name: 'Sam Cole', email: 'sam@example.com' })

    await withMcpClient(testApp, key, async (call) => {
      const found = await call('list_leads', { search: 'dana' })
      expect(found.data['total']).toBe(1)
      const [lead] = found.data['leads'] as { id: number; name: string }[]
      expect(lead?.name).toBe('Dana Reed')

      const detail = await call('get_lead', { leadId: lead?.id })
      const read = detail.data['lead'] as { fields: Record<string, unknown>; events: { type: string }[] }
      expect(read.fields['endorsements']).toBe('Hazmat')
      expect(read.events.map((event) => event.type)).toEqual(['created'])

      const stageList = await call('list_stages')
      const stagesRead = stageList.data['stages'] as { id: number; name: string }[]
      const target = stagesRead[1]
      expect(target).toBeDefined()

      const moved = await call('move_lead_stage', { leadId: lead?.id, stageId: target?.id })
      expect(moved.isError).toBe(false)
      expect((moved.data['lead'] as { stageName: string }).stageName).toBe(target?.name)

      const noted = await call('add_lead_note', { leadId: lead?.id, note: 'Phone screen booked.' })
      const events = (noted.data['lead'] as { events: { type: string; actor: string }[] }).events
      expect(events.map((event) => event.type)).toEqual(['created', 'stage_changed', 'note_added'])
      // One identity per credential — a lead an agent moved is distinguishable.
      expect(events[1]?.actor).toBe(`api_key:${record.id}`)
    })
  })

  it('reads the spam quarantine only when asked, and refuses a date it cannot parse', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })
    await submit(testApp, { name: 'Bot', email: 'bot@example.com', [HONEYPOT_FIELD]: 'filled' })

    await withMcpClient(testApp, key, async (call) => {
      const funnel = await call('list_leads')
      expect(funnel.data['total']).toBe(1)

      const quarantine = await call('list_leads', { spam: true })
      expect((quarantine.data['leads'] as { name: string }[])[0]?.name).toBe('Bot')

      // Dropping an unparseable bound would quietly widen the list instead.
      const refused = await call('list_leads', { createdAfter: 'last tuesday' })
      expect(refused.isError).toBe(true)
      expect(refused.data['error']).toBe('invalid_date')
    })
  })

  it('refuses answers nested deeper than the search index can walk', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    let deep: Record<string, unknown> = { bottom: true }
    for (let level = 0; level < MAX_FIELD_DEPTH; level += 1) deep = { nested: deep }

    await withMcpClient(testApp, key, async (call) => {
      const answer = await call('create_lead', { phone: '555-0100', fields: deep })

      expect(answer.isError).toBe(true)
      expect(answer.data).toEqual({ error: 'invalid_fields' })
      expect(testApp.db.select({ id: leads.id }).from(leads).all()).toHaveLength(0)
    })
  })

  it('reports a refused call as an error result rather than a protocol failure', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })

    await withMcpClient(testApp, key, async (call) => {
      const [lead] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
      const answer = await call('move_lead_stage', { leadId: lead?.id, stageId: 9_999 })

      expect(answer.isError).toBe(true)
      expect(answer.data).toEqual({ error: 'invalid_stage' })
    })
  })

  it('files a lead that was never submitted, and sends nothing for it', async () => {
    const onLeadCreated = vi.fn<(lead: CreatedLead) => void>()
    const testApp = createTestApp({ onLeadCreated })
    await setupAdmin(testApp)
    configureEmail(testApp)
    const { key, record } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const created = await call('create_lead', {
        name: 'Dana Reed',
        email: 'Dana@Example.com',
        source: 'Phone screen',
        fields: { years_experience: '6', equipment: 'Dry van' },
      })

      expect(created.isError).toBe(false)
      const lead = created.data['lead'] as {
        id: number
        email: string
        source: string
        formId: number | null
        isSpam: boolean
        stageId: number
        fields: Record<string, unknown>
        events: { type: string; actor: string; payload: Record<string, unknown> }[]
      }
      // Lowercased like every other write of this column.
      expect(lead.email).toBe('dana@example.com')
      expect(lead.source).toBe('Phone screen')
      expect(lead.formId).toBeNull()
      expect(lead.isSpam).toBe(false)
      expect(lead.stageId).toBe(firstStageId(testApp))
      expect(lead.fields['years_experience']).toBe('6')
      expect(lead.events).toHaveLength(1)
      expect(lead.events[0]?.type).toBe('created')
      expect(lead.events[0]?.actor).toBe(`api_key:${record.id}`)

      // The write reaches the search index like any other — one code path, but
      // the only one that inserts a lead without going through intake.
      const found = await call('list_leads', { search: 'dry van' })
      expect((found.data['leads'] as { id: number }[]).map((row) => row.id)).toEqual([lead.id])
    })

    // The acknowledgment thanks a person for a submission, and there was none.
    expect(onLeadCreated).not.toHaveBeenCalled()

    // And withholding the hook is not the whole guarantee: the boot sweep reaches
    // every recent lead with nothing sent against it, so without a durable mark
    // on the timeline the next restart would send both emails after all.
    const sender = recordingSender()
    const swept = await sweepUnsentEmails({
      db: testApp.db,
      appUrl: TEST_PUBLIC_BASE_URL,
      createSender: sender.factory,
      retry: { maxAttempts: 1, jitterRatio: 0 },
    })

    expect(swept).toBe(1)
    expect(sender.sent).toEqual([])
  })

  it('refuses a lead nobody could answer', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const answer = await call('create_lead', { name: 'Dana Reed' })

      expect(answer.isError).toBe(true)
      expect(answer.data).toEqual({ error: 'email_or_phone_required' })
      expect(testApp.db.select({ id: leads.id }).from(leads).all()).toHaveLength(0)
    })
  })

  it('files a lead under a named stage and refuses one that does not exist', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const stageList = await call('list_stages')
      const target = (stageList.data['stages'] as { id: number }[])[2]

      const created = await call('create_lead', { phone: '555-0100', stageId: target?.id })
      expect((created.data['lead'] as { stageId: number }).stageId).toBe(target?.id)

      const refused = await call('create_lead', { phone: '555-0101', stageId: 9_999 })
      expect(refused.isError).toBe(true)
      expect(refused.data).toEqual({ error: 'invalid_stage' })
    })
  })

  it('patches contact details, clearing only what is sent as null', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com', phone: '555-0100' })

    await withMcpClient(testApp, key, async (call) => {
      const [row] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()

      const patched = await call('update_lead', { leadId: row?.id, phone: null })
      const lead = patched.data['lead'] as { name: string; email: string; phone: string | null }
      expect(lead.phone).toBeNull()
      expect(lead.name).toBe('Dana Reed')
      expect(lead.email).toBe('dana@example.com')

      // The one edit that would leave nobody to answer.
      const refused = await call('update_lead', { leadId: row?.id, email: null })
      expect(refused.isError).toBe(true)
      expect(refused.data).toEqual({ error: 'email_or_phone_required' })
    })
  })

  it('merges details by key, and the timeline names keys but not values', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })

    await withMcpClient(testApp, key, async (call) => {
      const [row] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
      await call('update_lead', { leadId: row?.id, details: { start_date: 'Nov 2', licence: 'X123' } })
      const patched = await call('update_lead', { leadId: row?.id, details: { licence: null } })
      const lead = patched.data['lead'] as { details: Record<string, unknown> }
      expect(lead.details).toEqual({ start_date: 'Nov 2' })
    })
    const changes = testApp.db.select().from(leadEvents).where(eq(leadEvents.type, 'details_changed')).all()
    expect(changes.map((event) => event.payload)).toEqual(['{"keys":["licence","start_date"]}', '{"keys":["licence"]}'])
    expect(changes.every((event) => event.actor.startsWith('api_key:'))).toBe(true)
  })

  it('attaches, fetches and removes a file', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })
    const bytes = Buffer.from('%PDF-1.7 offer letter')

    await withMcpClient(testApp, key, async (call, client) => {
      const [row] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
      const added = await call('add_lead_attachment', {
        leadId: row?.id,
        filename: 'offer.pdf',
        contentType: 'application/pdf',
        data: bytes.toString('base64'),
      })
      expect(added.isError).toBe(false)
      const [attachment] = (added.data['lead'] as { attachments: { id: number; filename: string }[] }).attachments
      expect(attachment?.filename).toBe('offer.pdf')

      const fetched = await client.callTool({
        name: 'get_lead_attachment',
        arguments: { leadId: row?.id, attachmentId: attachment?.id },
      })
      expect(fetched.content).toEqual([
        {
          type: 'resource',
          resource: {
            uri: `philo://leads/${row?.id}/attachments/${attachment?.id}`,
            mimeType: 'application/pdf',
            blob: bytes.toString('base64'),
          },
        },
      ])

      const removed = await call('remove_lead_attachment', { leadId: row?.id, attachmentId: attachment?.id })
      expect((removed.data['lead'] as { attachments: unknown[] }).attachments).toEqual([])

      const gone = await call('get_lead_attachment', { leadId: row?.id, attachmentId: attachment?.id })
      expect(gone).toEqual({ isError: true, data: { error: 'attachment_not_found' } })
    })
  })

  it('deletes a lead for good, and says so when it is already gone', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })

    await withMcpClient(testApp, key, async (call, client) => {
      const { tools } = await client.listTools()
      const tool = tools.find((candidate) => candidate.name === 'delete_lead')
      expect(tool?.annotations?.destructiveHint).toBe(true)
      expect(tool?.description).toContain('cannot be undone')

      const [row] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
      expect(await call('delete_lead', { leadId: row?.id })).toEqual({ isError: false, data: { deleted: row?.id } })
      expect(testApp.db.select().from(leads).all()).toEqual([])
      expect(testApp.db.select().from(leadEvents).all()).toEqual([])

      expect(await call('delete_lead', { leadId: row?.id })).toEqual({ isError: true, data: { error: 'not_found' } })
    })
  })

  it('does not let a note through that the timeline could not hold', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })

    await withMcpClient(testApp, key, async (call) => {
      const [row] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
      const answer = await call('add_lead_note', { leadId: row?.id, note: '   ' })

      expect(answer.isError).toBe(true)
      expect(
        testApp.db.select().from(leadEvents).where(eq(leadEvents.type, 'note_added')).all(),
      ).toHaveLength(0)
    })
  })
})

describe('mcp stage tools', () => {
  type Stage = { id: number; name: string; position: number; isTerminal: boolean; leadCount: number }

  it('creates, renames, reorders and deletes a stage end to end', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const created = await call('create_stage', { name: 'Road test', isTerminal: false })
      expect(created.isError).toBe(false)
      const stage = created.data['stage'] as Stage
      expect(stage).toMatchObject({ name: 'Road test', isTerminal: false, leadCount: 0 })

      const renamed = await call('update_stage', { stageId: stage.id, name: 'Road test booked', isTerminal: true })
      expect(renamed.data['stage']).toMatchObject({ id: stage.id, name: 'Road test booked', isTerminal: true })

      const before = (await call('list_stages')).data['stages'] as Stage[]
      expect(before.at(-1)?.id).toBe(stage.id)
      const order = [stage.id, ...before.filter((s) => s.id !== stage.id).map((s) => s.id)]
      const reordered = await call('reorder_stages', { stageIds: order })
      expect((reordered.data['stages'] as Stage[]).map((s) => s.id)).toEqual(order)

      const deleted = await call('delete_stage', { stageId: stage.id })
      expect(deleted.isError).toBe(false)
      expect((deleted.data['stages'] as Stage[]).map((s) => s.id)).toEqual(order.slice(1))
    })
  })

  it('refuses a name the board could not show', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const blank = await call('create_stage', { name: '   ' })
      expect(blank.isError).toBe(true)
      expect(blank.data).toEqual({ error: 'invalid_name' })

      const stageId = firstStageId(testApp)
      const rename = await call('update_stage', { stageId, name: '   ' })
      expect(rename.data).toEqual({ error: 'invalid_name' })

      const missing = await call('update_stage', { stageId: 9_999, name: 'Ghost' })
      expect(missing.data).toEqual({ error: 'not_found' })
    })
  })

  it('refuses a partial order and moves nothing', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const before = (await call('list_stages')).data['stages'] as Stage[]
      const partial = await call('reorder_stages', { stageIds: before.slice(1).map((s) => s.id) })
      expect(partial.isError).toBe(true)
      expect(partial.data).toEqual({ error: 'invalid_order' })

      const after = (await call('list_stages')).data['stages'] as Stage[]
      expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id))
    })
  })

  it('will not delete a stage holding a lead, or the last stage', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })

    await withMcpClient(testApp, key, async (call) => {
      const occupied = await call('delete_stage', { stageId: firstStageId(testApp) })
      expect(occupied.isError).toBe(true)
      expect(occupied.data).toEqual({ error: 'stage_not_empty' })

      testApp.db.delete(leads).run()
      const all = (await call('list_stages')).data['stages'] as Stage[]
      for (const stage of all.slice(1)) {
        expect((await call('delete_stage', { stageId: stage.id })).isError).toBe(false)
      }
      const last = await call('delete_stage', { stageId: all[0]?.id })
      expect(last.data).toEqual({ error: 'last_stage' })
    })
  })
})

describe('mcp funnel tools', () => {
  it('creates a funnel and works its stages, templates and leads by funnelId', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const created = await call('create_funnel', { name: 'Owner-operators' })
      expect(created.isError).toBe(false)
      const funnel = created.data['funnel'] as { id: number; forms: { intakeUrl: string }[] }
      expect(funnel.forms).toHaveLength(1)

      const listed = (await call('list_funnels')).data['funnels'] as { id: number; isDefault: boolean }[]
      expect(listed.map((f) => [f.id, f.isDefault])).toEqual([
        [1, true],
        [funnel.id, false],
      ])

      const stage = await call('create_stage', { funnelId: funnel.id, name: 'Lease review' })
      expect(stage.isError).toBe(false)
      const defaults = (await call('list_stages')).data['stages'] as { name: string }[]
      expect(defaults.map((s) => s.name)).not.toContain('Lease review')

      await call('update_email_template', { funnelId: funnel.id, trigger: 'new_lead_ack', subject: 'Hi from {{funnel.name}}' })
      const preview = await call('preview_email_template', { funnelId: funnel.id, trigger: 'new_lead_ack' })
      expect((preview.data['preview'] as { subject: string }).subject).toBe('Hi from Owner-operators')
      expect(getEmailTemplate(testApp.db, 1, 'new_lead_ack')?.subject).toBe('Thanks for getting in touch')

      const lead = await call('create_lead', { email: 'pat@example.com', funnelId: funnel.id })
      expect((lead.data['lead'] as { funnelId: number }).funnelId).toBe(funnel.id)

      const updated = await call('update_funnel', { funnelId: funnel.id, notifyRecipients: ['ops@example.com'] })
      expect((updated.data['funnel'] as { notifyRecipients: string[] }).notifyRecipients).toEqual(['ops@example.com'])

      const refused = await call('delete_funnel', { funnelId: funnel.id })
      expect(refused.data['error']).toBe('funnel_not_empty')
    })
  })
})

describe('mcp email template tools', () => {
  it('edits a template and previews it without saving', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)

    await withMcpClient(testApp, key, async (call) => {
      const listed = await call('list_email_templates')
      expect((listed.data['templates'] as unknown[]).length).toBe(2)

      const saved = await call('update_email_template', {
        trigger: 'new_lead_ack',
        subject: 'Thanks, {{lead.name}}',
      })
      expect(saved.isError).toBe(false)
      expect((saved.data['template'] as { subject: string }).subject).toBe('Thanks, {{lead.name}}')

      const fetched = await call('get_email_template', { trigger: 'new_lead_ack' })
      expect((fetched.data['template'] as { subject: string }).subject).toBe('Thanks, {{lead.name}}')

      // A draft renders against the built-in sample and changes nothing.
      const preview = await call('preview_email_template', {
        trigger: 'new_lead_ack',
        subject: 'Hello {{lead.name}}',
      })
      const rendered = preview.data['preview'] as { subject: string; leadId: number | null }
      expect(rendered.subject).toBe('Hello Sample Applicant')
      expect(rendered.leadId).toBeNull()
      expect(getEmailTemplate(testApp.db, 1, 'new_lead_ack')?.subject).toBe('Thanks, {{lead.name}}')
    })
  })

  it('refuses source that does not compile, and says what is wrong with it', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    const before = getEmailTemplate(testApp.db, 1, 'new_lead_notify')?.body

    await withMcpClient(testApp, key, async (call) => {
      const answer = await call('update_email_template', {
        trigger: 'new_lead_notify',
        body: '{{#if lead.name}}unclosed',
      })

      expect(answer.isError).toBe(true)
      expect(answer.data['error']).toBe('invalid_body_template')
      expect(typeof answer.data['detail']).toBe('string')
    })

    expect(getEmailTemplate(testApp.db, 1, 'new_lead_notify')?.body).toBe(before)
  })

  it('previews against a real lead when one is named', async () => {
    const testApp = createTestApp()
    const { key } = agentKey(testApp)
    await submit(testApp, { name: 'Dana Reed', email: 'dana@example.com' })

    await withMcpClient(testApp, key, async (call) => {
      const [row] = testApp.db.select({ id: leads.id }).from(leads).limit(1).all()
      const preview = await call('preview_email_template', {
        trigger: 'new_lead_ack',
        subject: 'Hello {{lead.name}}',
        leadId: row?.id,
      })

      const rendered = preview.data['preview'] as { subject: string; leadId: number | null }
      expect(rendered.subject).toBe('Hello Dana Reed')
      expect(rendered.leadId).toBe(row?.id)
    })
  })
})
