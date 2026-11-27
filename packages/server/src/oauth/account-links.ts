import { TransactionRollbackError, and, eq, gt, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { csrf } from 'hono/csrf'
import { validatePassword } from '../auth/credentials.ts'
import { hashPassword } from '../auth/password.ts'
import { delay } from '../auth/rate-limit.ts'
import type { AuthGuards } from '../auth/routes.ts'
import { clientKey } from '../client-key.ts'
import type { Db } from '../db/index.ts'
import { accountLinks, users } from '../db/schema.ts'
import { findUsableLink, voidLinks } from '../users/links.ts'
import { MAX_NAME_LENGTH } from '../users/routes.ts'
import { revokeGrants } from '../users/service.ts'
import { renderLinkGone, renderLinkPage } from './consent.ts'

export interface AccountLinkDeps {
  db: Db
  publicBaseUrl: string
  /** Where a person lands once their password is set: the PWA, which signs them in. */
  appUrl: string
  trustProxy: boolean
  guards: AuthGuards
}

/**
 * Invite and reset links — ADR-0012, mounted at `/oauth/link` with the rest
 * of the built-in IdP. A GET only shows the form, so a mail scanner that
 * fetches the link spends nothing.
 */
export function createAccountLinkRoutes(deps: AccountLinkDeps): Hono {
  const routes = new Hono()

  // The token is in the path: keep it out of every Referer this page could
  // send, and out of shared and back-forward caches.
  routes.use('/*', async (c, next) => {
    await next()
    c.res.headers.set('Referrer-Policy', 'no-referrer')
    c.res.headers.set('Cache-Control', 'no-store')
  })
  routes.use('/*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.html(renderLinkGone(), 400) }))
  routes.use('/*', csrf({ origin: new URL(deps.publicBaseUrl).origin }))

  const usable = (token: string) => {
    const link = findUsableLink(deps.db, token)
    if (link === undefined) return undefined
    const [account] = deps.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, link.userId)).all()
    return account === undefined || account.disabledAt !== null ? undefined : link
  }

  routes.get('/:token', (c) => {
    const link = usable(c.req.param('token'))
    if (link === undefined) return c.html(renderLinkGone(), 410)
    return c.html(renderLinkPage({ purpose: link.purpose }))
  })

  routes.post('/:token', async (c) => {
    const token = c.req.param('token')
    // Tokens cannot be guessed; the throttle bounds what a stranger can make
    // this server hash.
    const key = `link:${clientKey(c, deps.trustProxy)}`
    deps.guards.throttle.recordAttempt(key)
    await delay(deps.guards.throttle.delayFor(key), c.req.raw.signal)

    const link = usable(token)
    if (link === undefined) return c.html(renderLinkGone(), 410)
    const body = await c.req.parseBody()
    const password = validatePassword(body['password'])
    if (password === undefined) {
      return c.html(renderLinkPage({ purpose: link.purpose, error: 'Choose a longer password.' }), 400)
    }
    if (!deps.guards.hashGate.tryAcquire()) {
      c.header('Retry-After', '1')
      return c.html(renderLinkPage({ purpose: link.purpose, error: 'Philo is busy. Try again.' }), 429)
    }
    let passwordHash: string
    try {
      passwordHash = await hashPassword(password)
    } finally {
      deps.guards.hashGate.release()
    }
    const rawName = typeof body['name'] === 'string' ? body['name'].trim().slice(0, MAX_NAME_LENGTH) : ''

    const now = new Date()
    const used = refusedOnRollback(() =>
      deps.db.transaction((tx) => {
        // Claimed in the same write that checks it, so two posts of one link cannot both win.
        const [claimed] = tx
          .update(accountLinks)
          .set({ usedAt: now })
          .where(and(eq(accountLinks.id, link.id), isNull(accountLinks.usedAt), gt(accountLinks.expiresAt, now)))
          .returning({ userId: accountLinks.userId })
          .all()
        if (claimed === undefined) return false
        const [account] = tx.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, claimed.userId)).all()
        if (account === undefined || account.disabledAt !== null) {
          // Deactivated since the page checked: undo the claim, so the link is refused, not spent.
          tx.rollback()
        }
        voidLinks(tx, claimed.userId, now)
        tx.update(users)
          .set({ passwordHash, ...(link.purpose === 'invite' && rawName !== '' ? { name: rawName } : {}) })
          .where(eq(users.id, claimed.userId))
          .run()
        // Whoever held the old password may hold its sessions too.
        if (link.purpose === 'reset') revokeGrants(tx, claimed.userId)
        return true
      }),
    )
    if (!used) return c.html(renderLinkGone(), 410)
    deps.guards.throttle.reset(key)
    return c.redirect(deps.appUrl, 302)
  })

  return routes
}

/** Runs a transaction that refuses by rolling back, reporting that refusal as `false`. */
function refusedOnRollback(run: () => boolean): boolean {
  try {
    return run()
  } catch (error) {
    if (error instanceof TransactionRollbackError) return false
    throw error
  }
}
