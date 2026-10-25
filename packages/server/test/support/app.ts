import { serve, type ServerType } from '@hono/node-server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/app.ts'
import { createFirstUser } from '../../src/auth/credentials.ts'
import type { ExternalIdp } from '../../src/auth/external-idp.ts'
import { hashPassword } from '../../src/auth/password.ts'
import type { AuthTuning } from '../../src/auth/routes.ts'
import { openDatabase, type Db } from '../../src/db/index.ts'
import { intakeForms } from '../../src/db/schema.ts'
import {
  writeEmailSettings,
  DEFAULT_EMAIL_SETTINGS,
  type EmailSettings,
} from '../../src/email/settings.ts'
import type { EmailSenderFactory, OutgoingEmail } from '../../src/email/transport.ts'
import type { IntakeTuning } from '../../src/intake/routes.ts'
import type { CreatedLead } from '../../src/notify.ts'
import { FIRST_PARTY_CLIENT_ID } from '../../src/oauth/first-party.ts'
import { loadOrCreateSigningKey, type SigningKey } from '../../src/oauth/signing-key.ts'
import { issueTokens, MCP_SCOPE } from '../../src/oauth/tokens.ts'
import { loadOrCreateVapidKeys } from '../../src/push/keys.ts'

export interface TestApp {
  app: ReturnType<typeof createApp>
  db: Db
  dataDir: string
  vapidPublicKey: string
  signingKey: SigningKey
}

const dataDirs: string[] = []
const openDbs: Db[] = []

/** Call from `afterEach`: closes databases and removes the temp directories. */
export function cleanupTestApps(): void {
  for (const db of openDbs.splice(0)) db.$client.close()
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Throttle delays shrunk to ~nothing. The curve is unit-tested directly; making
 * the route tests sleep the production seconds would buy nothing.
 */
const FAST_THROTTLE = { baseDelayMs: 1, maxDelayMs: 2 }

/** The issuer and API origin in tests, mirroring the config default. */
export const TEST_PUBLIC_BASE_URL = 'http://localhost:3000'

/** What `{{lead_url}}` resolves against: where the PWA is served. */
export const TEST_APP_URL = 'http://localhost:3000'

export function createTestApp(
  options: {
    publicBaseUrl?: string
    appUrl?: string
    mcpUrl?: string
    externalIdp?: ExternalIdp | undefined
    authTuning?: AuthTuning
    intakeTuning?: IntakeTuning | undefined
    onLeadCreated?: ((lead: CreatedLead) => void) | undefined
    createEmailSender?: EmailSenderFactory | undefined
    trustProxy?: boolean
  } = {},
): TestApp {
  const dataDir = mkdtempSync(join(tmpdir(), 'philo-app-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  openDbs.push(db)
  const tuning = options.authTuning ?? {}
  const vapidPublicKey = loadOrCreateVapidKeys(dataDir).keys.publicKey
  const signingKey = loadOrCreateSigningKey(dataDir)
  const publicBaseUrl = options.publicBaseUrl ?? TEST_PUBLIC_BASE_URL
  const app = createApp({
    db,
    publicBaseUrl,
    appUrl: options.appUrl ?? TEST_APP_URL,
    mcpUrl: options.mcpUrl ?? `${publicBaseUrl}/mcp`,
    signingKey,
    externalIdp: options.externalIdp,
    vapidPublicKey,
    trustProxy: options.trustProxy ?? false,
    authTuning: { ...tuning, throttle: { ...FAST_THROTTLE, ...tuning.throttle } },
    intakeTuning: options.intakeTuning,
    onLeadCreated: options.onLeadCreated,
    createEmailSender: options.createEmailSender,
  })
  return { app, db, dataDir, vapidPublicKey, signingKey }
}

/** Enough stored settings for `isEmailConfigured` to be true. */
export const TEST_EMAIL_SETTINGS: EmailSettings = {
  ...DEFAULT_EMAIL_SETTINGS,
  smtpHost: 'smtp.example.com',
  smtpUsername: 'apikey',
  smtpPassword: 'secret-token',
  fromName: 'Example Co',
  fromAddress: 'no-reply@example.com',
  replyTo: 'hello@example.com',
  businessName: 'Example Co',
}

export function configureEmail(testApp: TestApp, overrides: Partial<EmailSettings> = {}): EmailSettings {
  const config = { ...TEST_EMAIL_SETTINGS, ...overrides }
  writeEmailSettings(testApp.db, config)
  return config
}

export interface RecordingSender {
  sent: OutgoingEmail[]
  factory: EmailSenderFactory
}

/**
 * A sender that records instead of connecting.
 *
 * `failOn` makes a send reject outright, which is how the failure-isolation
 * cases are built. `rejectRecipient` models the subtler one: SMTP answers RCPT
 * per address, so a server can take one recipient, refuse another, and report
 * the whole thing as sent.
 */
export function recordingSender(
  options: {
    failOn?: (email: OutgoingEmail) => boolean
    rejectRecipient?: (address: string) => boolean
  } = {},
): RecordingSender {
  const sent: OutgoingEmail[] = []
  return {
    sent,
    factory: () => async (email) => {
      if (options.failOn?.(email) === true) throw new Error('smtp refused the message')
      sent.push(email)
      return { accepted: email.to.filter((address) => options.rejectRecipient?.(address) !== true) }
    },
  }
}

/**
 * Serves the app on a real socket and hands back its base URL.
 *
 * `app.request()` has no socket behind it, so the peer address is unknown — and
 * `PHILO_TRUSTED_PROXY` deliberately refuses to believe `X-Forwarded-For` without
 * a private peer vouching for it. Testing that path at all therefore needs a real
 * listener, where the peer is loopback exactly as it is behind a real proxy.
 */
export async function withServer<T>(
  testApp: TestApp,
  body: (baseUrl: string) => Promise<T>,
): Promise<T> {
  // Port 0 is only resolved once the socket is listening, so the callback is
  // what has the answer — `server.address()` is still null when serve() returns.
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const started = serve({ fetch: testApp.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ server: started, port: info.port })
    })
  })
  try {
    return await body(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The form key seeded on first boot — what a fresh instance actually serves. */
export function defaultFormKey(testApp: TestApp): string {
  const [form] = testApp.db.select({ formKey: intakeForms.formKey }).from(intakeForms).limit(1).all()
  if (form === undefined) throw new Error('no intake form was seeded')
  return form.formKey
}

/** An extra form, for the CORS cases the wide-open seeded default cannot show. */
export function createIntakeForm(
  testApp: TestApp,
  formKey: string,
  origins: string[],
  name = 'Careers',
): string {
  testApp.db
    .insert(intakeForms)
    .values({ name, formKey, allowedOrigins: JSON.stringify(origins) })
    .run()
  return formKey
}

export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

export const ADMIN_EMAIL = 'admin@example.com'
export const ADMIN_PASSWORD = 'correct-horse-battery-staple'

/**
 * Creates the operator account directly, as first-boot setup would, and
 * returns an `Authorization` header value for an operator token — what the PWA
 * holds after signing in. The dialog that does this for real is covered in
 * oauth.test.ts.
 */
export async function setupAdmin(
  testApp: TestApp,
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): Promise<string> {
  const user = createFirstUser(testApp.db, { email, passwordHash: await hashPassword(password), name: 'Admin' })
  if (user === undefined) throw new Error('setup failed: an account already exists')
  return operatorAuth(testApp, user.id)
}

/** A fresh operator token for an existing account. */
export function operatorAuth(testApp: TestApp, userId: number): string {
  const { accessToken } = issueTokens(testApp.db, {
    clientId: FIRST_PARTY_CLIENT_ID,
    userId,
    resource: null,
    scope: 'openid operator',
  })
  return `Bearer ${accessToken}`
}

/**
 * An agent token from a dynamically registered connector — the same authority
 * as an API key. Registers the client row the token references.
 */
export async function agentAuth(testApp: TestApp, userId: number): Promise<{ authorization: string; clientId: string }> {
  const res = await testApp.app.request(
    '/oauth/register',
    jsonPost({ redirect_uris: ['https://client.example.com/cb'], token_endpoint_auth_method: 'none' }),
  )
  const { client_id: clientId } = (await res.json()) as { client_id: string }
  const { accessToken } = issueTokens(testApp.db, { clientId, userId, resource: null, scope: MCP_SCOPE })
  return { authorization: `Bearer ${accessToken}`, clientId }
}
