import { asc } from 'drizzle-orm'
import webpush, { WebPushError } from 'web-push'
import type { Db } from '../db/index.ts'
import { users } from '../db/schema.ts'
import { getLead, type LeadRecord } from '../leads/service.ts'
import type { LeadCreatedHook } from '../notify.ts'
import { vapidSubject, type VapidKeys } from './keys.ts'
import { deleteSubscription, listSubscriptions, type StoredSubscription } from './subscriptions.ts'

/**
 * The Declarative Web Push magic number — the format's version tag, and what
 * tells a user agent this payload can be rendered without waking a service
 * worker. Safari 18.4+ takes that path; everyone else lands in web/src/sw.js,
 * which reads the same `notification` object.
 */
const DECLARATIVE_WEB_PUSH_VERSION = 8030

/**
 * How long a push service should hold the message for a device that is offline.
 * A new lead is worth delivering late; it is not worth delivering tomorrow, and
 * the email has arrived regardless.
 */
const TTL_SECONDS = 6 * 60 * 60

/** Nothing on a phone's lock screen reads past this, and a push has a size budget. */
const MAX_TEXT_LENGTH = 200

/**
 * A push a receiver could not accept, ever: the subscription is gone. 404 is the
 * endpoint never existing, 410 is it having expired — every push service answers
 * one of the two, and both mean the row is dead rather than the send being
 * unlucky. Anything else (a 429, a 500, a timeout) is the service having a bad
 * moment and is left alone.
 */
const DEAD_SUBSCRIPTION_STATUSES: ReadonlySet<number> = new Set([404, 410])

/** The declarative payload, exactly as it goes on the wire. */
export interface DeclarativeNotification {
  web_push: number
  notification: {
    title: string
    body: string
    /** Where a tap lands. Required by the declarative format, and read by sw.js. */
    navigate: string
    /** Collapses a repeat for the same lead instead of stacking a second banner. */
    tag: string
  }
}

/** Substituted in tests. Production gets `web-push`. */
export type SendPush = (subscription: StoredSubscription, payload: string) => Promise<unknown>

export interface PushDeps {
  db: Db
  /** Builds the URL a tap opens, as it does on the email path. */
  publicBaseUrl: string
  vapidKeys: VapidKeys
  send?: SendPush | undefined
}

function clamp(value: string): string {
  return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 1)}…`
}

/**
 * What the banner says. The name if there is one — a lead reachable only by
 * phone has none, and "New lead" is still the fact worth waking someone for.
 * The body carries whatever contact detail exists, so the operator can decide
 * whether to open the app without opening the app.
 */
export function buildLeadNotification(lead: LeadRecord, publicBaseUrl: string): DeclarativeNotification {
  const name = lead.name?.trim() ?? ''
  const details = [lead.email, lead.phone, lead.source]
    .map((value) => value?.trim() ?? '')
    .filter((value) => value !== '')
  return {
    web_push: DECLARATIVE_WEB_PUSH_VERSION,
    notification: {
      title: clamp(name === '' ? 'New lead' : `New lead: ${name}`),
      body: clamp(details.length === 0 ? 'Open Philo to see the details.' : details.join(' · ')),
      navigate: `${publicBaseUrl.replace(/\/+$/, '')}/leads/${lead.id}`,
      tag: `philo-lead-${lead.id}`,
    },
  }
}

/**
 * The earliest account, as fallback contact for the VAPID `sub` claim. Only
 * consulted for a non-https base URL — see `vapidSubject`.
 */
function firstOperatorEmail(db: Db): string | undefined {
  const [row] = db.select({ email: users.email }).from(users).orderBy(asc(users.id)).limit(1).all()
  return row?.email
}

function realSend(keys: VapidKeys, subject: string): SendPush {
  return (subscription, payload) =>
    webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      payload,
      {
        TTL: TTL_SECONDS,
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      },
    )
}

/** A subscription the push service says no longer exists. */
function isDead(error: unknown): boolean {
  return error instanceof WebPushError && DEAD_SUBSCRIPTION_STATUSES.has(error.statusCode)
}

/**
 * Pushes the new lead to every subscribed browser, and forgets the ones that
 * have gone away.
 *
 * Never throws and never rejects: ADR-0004 makes push the best-effort channel
 * behind a guaranteed email, and DESIGN.md (Intake endpoint) puts every
 * downstream failure behind the 201 the form already has. A subscription that
 * fails is logged and skipped — one dead phone must not cost another its
 * notification.
 */
export async function sendNewLeadPush(deps: PushDeps, leadId: number): Promise<void> {
  try {
    const lead = getLead(deps.db, leadId)
    if (lead === undefined) return
    // Belt to the callers' braces: intake and the promotion route both withhold
    // the hook for a quarantined lead already.
    if (lead.isSpam) return

    const subscriptions = listSubscriptions(deps.db)
    if (subscriptions.length === 0) return

    const send = deps.send ?? buildSender(deps)
    if (send === undefined) return

    const payload = JSON.stringify(buildLeadNotification(lead, deps.publicBaseUrl))
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await send(subscription, payload)
        } catch (error: unknown) {
          handleSendFailure(deps.db, leadId, subscription, error)
        }
      }),
    )
  } catch (error: unknown) {
    console.error(`lead ${leadId}: new-lead push failed`, error)
  }
}

/** Undefined when there is no usable VAPID subject, which is a send that cannot be signed. */
function buildSender(deps: PushDeps): SendPush | undefined {
  const subject = vapidSubject(deps.publicBaseUrl, firstOperatorEmail(deps.db))
  if (subject === undefined) {
    console.warn(
      'push: no VAPID contact could be determined, so no notification was sent. ' +
        'Set PHILO_PUBLIC_BASE_URL to the https URL you serve on.',
    )
    return undefined
  }
  return realSend(deps.vapidKeys, subject)
}

function handleSendFailure(db: Db, leadId: number, subscription: StoredSubscription, error: unknown): void {
  if (isDead(error)) {
    // Pruned rather than retried: the browser threw the subscription away, and
    // the row would otherwise be attempted on every lead forever.
    try {
      deleteSubscription(db, subscription.endpoint)
    } catch (deleteError: unknown) {
      console.error('push: could not prune a dead subscription', deleteError)
    }
    return
  }
  if (error instanceof WebPushError && error.statusCode === 403) {
    // Worth naming: this is what a stored subscription answers after the VAPID
    // pair it was made with was replaced. Re-subscribing in Settings fixes it.
    console.error(
      `lead ${leadId}: push refused the VAPID key for ${subscription.endpoint}. ` +
        'Turn notifications off and on again in Settings to re-subscribe.',
    )
    return
  }
  console.error(`lead ${leadId}: push failed for ${subscription.endpoint}`, error)
}

/** What `AppOptions.onLeadCreated` is wired to in production — see src/index.ts. */
export function createLeadPushHook(deps: PushDeps): LeadCreatedHook {
  return (lead) => {
    void sendNewLeadPush(deps, lead.id)
  }
}
