import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { normalizeEmail, validatePassword } from '../auth/credentials.ts'
import { bearerToken, currentUser, principalRole, type AuthEnv } from '../auth/middleware.ts'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import { delay } from '../auth/rate-limit.ts'
import type { AuthGuards } from '../auth/routes.ts'
import type { Role } from '../auth/session.ts'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { readJsonBody } from '../json-body.ts'
import { hashAccessToken } from '../oauth/tokens.ts'
import { linkUrl } from './links.ts'
import {
  changePassword,
  invitePerson,
  issueResetLink,
  listPeople,
  reinvitePerson,
  updatePerson,
  type PeopleMode,
  type PersonPatch,
} from './service.ts'

/** Bounds a display name, as the setup dialog does. */
export const MAX_NAME_LENGTH = 200

export interface UserRoutesDeps {
  db: Db
  mode: PeopleMode
  /** Where invite and reset links open: the built-in IdP's origin. */
  publicBaseUrl: string
  /** The built-in IdP's password budget. Undefined with an external IdP, which has no passwords. */
  guards: AuthGuards | undefined
}

function parseId(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

function parseRole(raw: unknown): Role | undefined {
  return raw === 'user' || raw === 'admin' ? raw : undefined
}

/** `undefined`: not given; `null`: cleared; a string: the trimmed, bounded name. Errors are `false`. */
function parseName(raw: unknown): string | null | undefined | false {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  if (trimmed.length > MAX_NAME_LENGTH) return false
  return trimmed === '' ? null : trimmed
}

const STATUS: Record<string, 400 | 404 | 409> = {
  not_found: 404,
  cannot_change_self: 409,
  last_admin: 409,
  role_managed_by_idp: 409,
  not_invited: 409,
  account_disabled: 409,
  email_taken: 409,
}

function fail(c: Context, error: string) {
  return c.json({ error }, STATUS[error] ?? 400)
}

/**
 * People — ADR-0012. Every user may list them, so the timeline can name a
 * colleague; every change is admin-only, which app.ts's role guard enforces.
 */
export function createUserRoutes(deps: UserRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()
  const { db, mode } = deps

  routes.get('/', (c) =>
    c.json({ users: listPeople(db, mode), invites: mode.builtIn, rolesManagedByIdp: mode.policy.rolesFromIdp }),
  )

  routes.post('/', async (c) => {
    if (!mode.builtIn) return c.json({ error: 'managed_by_idp' }, 409)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const email = normalizeEmail(body['email'])
    if (email === undefined) return c.json({ error: 'invalid_email' }, 400)
    const role = parseRole(body['role'])
    if (role === undefined) return c.json({ error: 'invalid_role' }, 400)
    const name = parseName(body['name'])
    if (name === false) return c.json({ error: 'invalid_name' }, 400)

    const result = await invitePerson(db, mode, { email, role, name: name ?? null }, currentUser(c).id)
    if (!result.ok) return fail(c, result.error)
    const { person, link } = result.value
    return c.json(
      { user: person, inviteUrl: linkUrl(deps.publicBaseUrl, link.token), expiresAt: link.expiresAt.toISOString() },
      201,
    )
  })

  routes.patch('/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const patch: PersonPatch = {}
    if (body['role'] !== undefined) {
      const role = parseRole(body['role'])
      if (role === undefined) return c.json({ error: 'invalid_role' }, 400)
      patch.role = role
    }
    if (body['disabled'] !== undefined) {
      if (typeof body['disabled'] !== 'boolean') return c.json({ error: 'invalid_request' }, 400)
      patch.disabled = body['disabled']
    }
    const result = updatePerson(db, mode, currentUser(c).id, id, patch)
    return result.ok ? c.json({ user: result.value }) : fail(c, result.error)
  })

  routes.post('/:id/invite', async (c) => {
    if (!mode.builtIn) return c.json({ error: 'managed_by_idp' }, 409)
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = await reinvitePerson(db, mode, id, currentUser(c).id)
    if (!result.ok) return fail(c, result.error)
    const { person, link } = result.value
    return c.json({ user: person, inviteUrl: linkUrl(deps.publicBaseUrl, link.token), expiresAt: link.expiresAt.toISOString() })
  })

  routes.post('/:id/reset-link', (c) => {
    if (!mode.builtIn) return c.json({ error: 'managed_by_idp' }, 409)
    const id = parseId(c.req.param('id'))
    if (id === undefined) return c.json({ error: 'invalid_request' }, 400)
    const result = issueResetLink(db, mode, id, currentUser(c).id)
    if (!result.ok) return fail(c, result.error)
    return c.json({ resetUrl: linkUrl(deps.publicBaseUrl, result.value.token), expiresAt: result.value.expiresAt.toISOString() })
  })

  return routes
}

/**
 * The current password, checked under the built-in IdP's shared throttle and
 * hashing budget — a stolen token must not make guessing it free.
 */
async function currentPasswordMatches(
  c: Context<AuthEnv>,
  deps: UserRoutesDeps,
  guards: AuthGuards,
  userId: number,
  given: unknown,
): Promise<boolean | 'busy'> {
  if (typeof given !== 'string' || given === '') return false
  const key = `account:${userId}`
  guards.throttle.recordAttempt(key)
  await delay(guards.throttle.delayFor(key), c.req.raw.signal)
  const [row] = deps.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).all()
  if (row === undefined) return false
  if (!guards.hashGate.tryAcquire()) return 'busy'
  try {
    const ok = await verifyPassword(row.passwordHash, given)
    if (ok) guards.throttle.reset(key)
    return ok
  } finally {
    guards.hashGate.release()
  }
}

/** A person's own account — ADR-0012. Open to every user. */
export function createAccountRoutes(deps: UserRoutesDeps): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>()
  const { db, guards } = deps

  const account = (c: Context<AuthEnv>) => {
    const user = currentUser(c)
    const [row] = db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, user.id)).all()
    return {
      account: {
        id: user.id,
        name: row?.name ?? user.name,
        email: row?.email ?? user.email,
        role: principalRole(c),
        managedByIdp: guards === undefined,
      },
    }
  }

  routes.get('/', (c) => c.json(account(c)))

  routes.patch('/', async (c) => {
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const userId = currentUser(c).id
    const name = parseName(body['name'])
    if (name === false) return c.json({ error: 'invalid_name' }, 400)
    let email: string | undefined
    if (body['email'] !== undefined) {
      if (guards === undefined) return c.json({ error: 'managed_by_idp' }, 409)
      email = normalizeEmail(body['email'])
      if (email === undefined) return c.json({ error: 'invalid_email' }, 400)
      const matches = await currentPasswordMatches(c, deps, guards, userId, body['currentPassword'])
      if (matches === 'busy') return c.json({ error: 'busy' }, 429)
      if (!matches) return c.json({ error: 'wrong_password' }, 400)
    }
    const changed = db.transaction((tx) => {
      if (email !== undefined) {
        const holder = tx.select({ id: users.id }).from(users).where(eq(users.email, email)).all()[0]
        if (holder !== undefined && holder.id !== userId) return false
      }
      const set = { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) }
      if (Object.keys(set).length > 0) tx.update(users).set(set).where(eq(users.id, userId)).run()
      return true
    })
    if (!changed) return c.json({ error: 'email_taken' }, 409)
    return c.json(account(c))
  })

  routes.post('/password', async (c) => {
    if (guards === undefined) return c.json({ error: 'managed_by_idp' }, 409)
    const body = await readJsonBody(c)
    if (body === undefined) return c.json({ error: 'invalid_request' }, 400)
    const userId = currentUser(c).id
    const matches = await currentPasswordMatches(c, deps, guards, userId, body['currentPassword'])
    if (matches === 'busy') return c.json({ error: 'busy' }, 429)
    if (!matches) return c.json({ error: 'wrong_password' }, 400)
    const password = validatePassword(body['newPassword'])
    if (password === undefined) return c.json({ error: 'invalid_password' }, 400)
    if (!guards.hashGate.tryAcquire()) return c.json({ error: 'busy' }, 429)
    let passwordHash: string
    try {
      passwordHash = await hashPassword(password)
    } finally {
      guards.hashGate.release()
    }
    const token = bearerToken(c.req.header('authorization'))
    changePassword(db, userId, passwordHash, token === undefined ? undefined : hashAccessToken(token))
    return c.body(null, 204)
  })

  return routes
}

