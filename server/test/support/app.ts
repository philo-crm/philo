import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/app.ts'
import { loadOrCreateSessionKey } from '../../src/auth/session-key.ts'
import { SESSION_COOKIE_NAME } from '../../src/auth/session.ts'
import { openDatabase, type Db } from '../../src/db/index.ts'

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

/** A minimal stand-in for the Vite build, so static-asset routes have something to serve. */
export function createPublicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'philo-public-'))
  dataDirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Philo</title>')
  writeFileSync(join(dir, 'app.js'), 'console.log("philo")')
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("hashed")')
  return dir
}

export function createTestApp(options: { cookieSecure?: boolean } = {}): TestApp {
  const dataDir = mkdtempSync(join(tmpdir(), 'philo-app-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  openDbs.push(db)
  const publicDir = createPublicDir()
  const app = createApp({
    db,
    sessionKey: loadOrCreateSessionKey(dataDir),
    cookieSecure: options.cookieSecure ?? false,
    publicDir,
  })
  return { app, db, dataDir, publicDir }
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
 * The session cookie's `name=value` pair, ready to send back as a `Cookie`
 * header. Undefined when the response cleared the cookie or never set one.
 */
export function sessionCookie(res: Response): string | undefined {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    if (pair === undefined) continue
    const [name, ...rest] = pair.split('=')
    if (name !== SESSION_COOKIE_NAME) continue
    const value = rest.join('=')
    return value.length > 0 ? pair : undefined
  }
  return undefined
}

/** The raw `Set-Cookie` line for the session cookie, for asserting on its attributes. */
export function sessionCookieAttributes(res: Response): string | undefined {
  return res.headers.getSetCookie().find((raw) => raw.startsWith(`${SESSION_COOKIE_NAME}=`))
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
