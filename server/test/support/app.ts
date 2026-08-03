import { serve, type ServerType } from '@hono/node-server'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/app.ts'
import type { AuthTuning } from '../../src/auth/routes.ts'
import { loadOrCreateSessionKey } from '../../src/auth/session-key.ts'
import { SESSION_COOKIE_NAME } from '../../src/auth/session.ts'
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

export interface TestApp {
  app: ReturnType<typeof createApp>
  db: Db
  dataDir: string
  publicDir: string
}

const dataDirs: string[] = []
const openDbs: Db[] = []

/** Call from `afterEach`: closes databases and removes the temp directories. */
export function cleanupTestApps(): void {
  for (const db of openDbs.splice(0)) db.$client.close()
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * A minimal stand-in for the Vite build, so static-asset routes have something
 * to serve. `withPwaFiles: false` models a build that never emitted them.
 */
export function createPublicDir({ withPwaFiles = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'philo-public-'))
  dataDirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Philo</title>')
  writeFileSync(join(dir, 'app.js'), 'console.log("philo")')
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("hashed")')
  if (withPwaFiles) {
    writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("push", () => {})')
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Philo","short_name":"Philo"}')
  }
  return dir
}

/**
 * Throttle delays shrunk to ~nothing. The curve is unit-tested directly; making
 * the route tests sleep the production seconds would buy nothing.
 */
const FAST_THROTTLE = { baseDelayMs: 1, maxDelayMs: 2 }

export function createTestApp(
  options: {
    cookieSecure?: boolean
    authTuning?: AuthTuning
    intakeTuning?: IntakeTuning | undefined
    onLeadCreated?: ((lead: CreatedLead) => void) | undefined
    createEmailSender?: EmailSenderFactory | undefined
    trustProxy?: boolean
    publicDir?: string
  } = {},
): TestApp {
  const dataDir = mkdtempSync(join(tmpdir(), 'philo-app-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  openDbs.push(db)
  const publicDir = options.publicDir ?? createPublicDir()
  const tuning = options.authTuning ?? {}
  const app = createApp({
    db,
    sessionKey: loadOrCreateSessionKey(dataDir),
    cookieSecure: options.cookieSecure ?? false,
    trustProxy: options.trustProxy ?? false,
    publicDir,
    authTuning: { ...tuning, throttle: { ...FAST_THROTTLE, ...tuning.throttle } },
    intakeTuning: options.intakeTuning,
    onLeadCreated: options.onLeadCreated,
    createEmailSender: options.createEmailSender,
  })
  return { app, db, dataDir, publicDir }
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

/** Same origin as the URL `app.request()` builds, so `csrf()` treats calls as first-party. */
export const TEST_ORIGIN = 'http://localhost'

export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, ...headers },
    body: JSON.stringify(body),
  }
}

/**
 * The last `Set-Cookie` line for the session cookie. Last, not first, because a
 * response can carry more than one for the same name — a request presenting a
 * dead cookie has it cleared by the middleware and re-set by the handler — and a
 * browser's jar ends up holding whichever came last.
 */
export function sessionCookieAttributes(res: Response): string | undefined {
  return res.headers.getSetCookie().findLast((raw) => raw.startsWith(`${SESSION_COOKIE_NAME}=`))
}

/**
 * The session cookie's `name=value` pair, ready to send back as a `Cookie`
 * header. Undefined when the response cleared the cookie or never set one.
 */
export function sessionCookie(res: Response): string | undefined {
  const raw = sessionCookieAttributes(res)
  if (raw === undefined) return undefined
  const [pair] = raw.split(';')
  if (pair === undefined) return undefined
  const value = pair.slice(`${SESSION_COOKIE_NAME}=`.length)
  return value.length > 0 ? pair : undefined
}

export const ADMIN_EMAIL = 'admin@example.com'
export const ADMIN_PASSWORD = 'correct-horse-battery-staple'

/** Completes first-boot setup and returns the resulting session cookie. */
export async function setupAdmin(
  testApp: TestApp,
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): Promise<string> {
  const res = await testApp.app.request('/api/v1/auth/setup', jsonPost({ email, password, name: 'Admin' }))
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`)
  const cookie = sessionCookie(res)
  if (cookie === undefined) throw new Error('setup did not set a session cookie')
  return cookie
}

export async function login(
  testApp: TestApp,
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): Promise<Response> {
  return testApp.app.request('/api/v1/auth/login', jsonPost({ email, password }))
}
