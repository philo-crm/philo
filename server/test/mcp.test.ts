import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { asc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiKey, revokeApiKey } from '../src/auth/api-keys.ts'
import { leadEvents, leads, stages } from '../src/db/schema.ts'
import { sweepUnsentEmails } from '../src/email/service.ts'
import { getEmailTemplate } from '../src/email/templates.ts'
import { HONEYPOT_FIELD, MAX_FIELD_DEPTH } from '../src/intake/payload.ts'
import { MAX_MCP_BODY_BYTES } from '../src/mcp/routes.ts'
import type { CreatedLead } from '../src/notify.ts'
import {
  cleanupTestApps,
  configureEmail,
  createTestApp,
  defaultFormKey,
  recordingSender,
  setupAdmin,
  withServer,
  TEST_PUBLIC_BASE_URL,
  type TestApp,
} from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

/** Every tool DESIGN.md (MCP surface) names for the MVP. */
const TOOL_NAMES = [
  'add_lead_note',
  'create_lead',
  'get_email_template',
  'get_lead',
  'list_email_templates',
  'list_leads',
  'list_stages',
  'move_lead_stage',
  'preview_email_template',
  'update_email_template',
  'update_lead',
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
  it('refuses a request with no credential and asks for a bearer one', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE))

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="philo"')
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('names the credential as the problem when one was presented', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request(
      '/mcp',
      jsonRpcPost(INITIALIZE, { authorization: 'Bearer philo_not-a-real-key' }),
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="philo", error="invalid_token"')
  })

  it('stops accepting a key the moment it is revoked', async () => {
    const testApp = createTestApp()
    const { key, record } = createApiKey(testApp.db, 'Agent')
    const authorized = { authorization: `Bearer ${key}` }

    expect((await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE, authorized))).status).toBe(200)
    revokeApiKey(testApp.db, record.id)

    // Revocation is a row delete and this surface holds nothing between
    // requests, so there is no cached session for a key to outlive itself in.
    const after = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE, authorized))
    expect(after.status).toBe(401)
  })

  it('does not accept a session cookie in place of a key', async () => {
    const testApp = createTestApp()
    const cookie = await setupAdmin(testApp)
    const res = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE, { cookie }))

    expect(res.status).toBe(401)
  })

  it('answers GET with 405 rather than holding a stream open', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')
    const res = await testApp.app.request('/mcp', {
      headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' },
    })

    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })

  it('bounds the request body', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')
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

  it('keeps answers out of shared caches', async () => {
    const testApp = createTestApp()
    const res = await testApp.app.request('/mcp', jsonRpcPost(INITIALIZE))

    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('serves every MVP tool', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')

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
    const { key, record } = createApiKey(testApp.db, 'Agent')
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
    const { key } = createApiKey(testApp.db, 'Agent')
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
    const { key } = createApiKey(testApp.db, 'Agent')
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
    const { key } = createApiKey(testApp.db, 'Agent')
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
    const { key, record } = createApiKey(testApp.db, 'Agent')

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
      publicBaseUrl: TEST_PUBLIC_BASE_URL,
      createSender: sender.factory,
      retry: { maxAttempts: 1, jitterRatio: 0 },
    })

    expect(swept).toBe(1)
    expect(sender.sent).toEqual([])
  })

  it('refuses a lead nobody could answer', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')

    await withMcpClient(testApp, key, async (call) => {
      const answer = await call('create_lead', { name: 'Dana Reed' })

      expect(answer.isError).toBe(true)
      expect(answer.data).toEqual({ error: 'email_or_phone_required' })
      expect(testApp.db.select({ id: leads.id }).from(leads).all()).toHaveLength(0)
    })
  })

  it('files a lead under a named stage and refuses one that does not exist', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')

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
    const { key } = createApiKey(testApp.db, 'Agent')
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

  it('does not let a note through that the timeline could not hold', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')
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

describe('mcp email template tools', () => {
  it('edits a template and previews it without saving', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')

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
      expect(getEmailTemplate(testApp.db, 'new_lead_ack')?.subject).toBe('Thanks, {{lead.name}}')
    })
  })

  it('refuses source that does not compile, and says what is wrong with it', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')
    const before = getEmailTemplate(testApp.db, 'new_lead_notify')?.body

    await withMcpClient(testApp, key, async (call) => {
      const answer = await call('update_email_template', {
        trigger: 'new_lead_notify',
        body: '{{#if lead.name}}unclosed',
      })

      expect(answer.isError).toBe(true)
      expect(answer.data['error']).toBe('invalid_body_template')
      expect(typeof answer.data['detail']).toBe('string')
    })

    expect(getEmailTemplate(testApp.db, 'new_lead_notify')?.body).toBe(before)
  })

  it('previews against a real lead when one is named', async () => {
    const testApp = createTestApp()
    const { key } = createApiKey(testApp.db, 'Agent')
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
