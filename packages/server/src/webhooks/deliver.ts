import { createHmac, randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { Db } from '../db/index.ts'
import type { ChangeEvent, ChangeFeed } from '../events/feed.ts'
import { VERSION } from '../version.ts'
import { recordDelivery, webhooksFor, type WebhookDelivery, type WebhookTarget } from './service.ts'

export interface DeliveryTuning {
  timeoutMs?: number | undefined
  /** Waits before each retry; its length is how many retries there are. */
  retryDelaysMs?: readonly number[] | undefined
  fetch?: typeof fetch | undefined
  /** Resolves a host to every address it has. Tests substitute their own. */
  lookup?: ((host: string) => Promise<string[]>) | undefined
}

const TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [10_000, 60_000] as const

/**
 * Addresses no receiver lives at. Loopback and private ranges stay reachable on
 * purpose — ADR-0010: a workflow tool on the same host is a real target — but
 * link-local is where cloud metadata services answer, and nothing legitimate
 * listens on an unspecified or multicast address.
 */
const FORBIDDEN = new BlockList()
FORBIDDEN.addSubnet('0.0.0.0', 8, 'ipv4')
FORBIDDEN.addSubnet('169.254.0.0', 16, 'ipv4')
FORBIDDEN.addSubnet('224.0.0.0', 4, 'ipv4')
FORBIDDEN.addAddress('::', 'ipv6')
FORBIDDEN.addSubnet('fe80::', 10, 'ipv6')
FORBIDDEN.addSubnet('ff00::', 8, 'ipv6')

function isForbidden(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1]
  if (mapped !== undefined) return FORBIDDEN.check(mapped, 'ipv4')
  return FORBIDDEN.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

async function resolveAll(host: string): Promise<string[]> {
  const found = await dnsLookup(host, { all: true, verbatim: true })
  return found.map((entry) => entry.address)
}

/** Checked at every attempt, not at registration, so a DNS change cannot slip past it. */
async function refusedTarget(url: string, tuning: DeliveryTuning): Promise<string | undefined> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) === 0 ? await (tuning.lookup ?? resolveAll)(host) : [host]
  return addresses.some(isForbidden) ? 'address not allowed' : undefined
}

/** What a receiver verifies: HMAC-SHA256 over `<timestamp>.<body>` — ADR-0010. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

interface Payload {
  id: string
  type: string
  body: string
}

/** One attempt. Never throws: the outcome is recorded on the registration and returned. */
async function attempt(db: Db, target: WebhookTarget, payload: Payload, tuning: DeliveryTuning): Promise<WebhookDelivery> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  let status: number | null = null
  let error: string | null = null
  try {
    const refused = await refusedTarget(target.url, tuning)
    if (refused !== undefined) throw new Error(refused)
    const res = await (tuning.fetch ?? fetch)(target.url, {
      method: 'POST',
      // A redirect would send a signed body somewhere nobody registered.
      redirect: 'manual',
      signal: AbortSignal.timeout(tuning.timeoutMs ?? TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `philo/${VERSION}`,
        'X-Philo-Event': payload.type,
        'X-Philo-Delivery': payload.id,
        'X-Philo-Timestamp': timestamp,
        'X-Philo-Signature': signPayload(target.secret, timestamp, payload.body),
      },
      body: payload.body,
    })
    status = res.status
    if (!res.ok) error = `HTTP ${res.status}`
    // Nothing in the answer is used; read it so the connection can be reused.
    await res.body?.cancel()
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  try {
    recordDelivery(db, target.id, status, error)
  } catch (caught: unknown) {
    // A closed database at shutdown; the delivery itself already happened or not.
    console.error('could not record a webhook delivery', caught)
  }
  return { at: new Date().toISOString(), status, ok: error === null, error }
}

function deliver(db: Db, target: WebhookTarget, payload: Payload, tuning: DeliveryTuning, retry = 0): void {
  void attempt(db, target, payload, tuning).then((outcome) => {
    const delays = tuning.retryDelaysMs ?? RETRY_DELAYS_MS
    const delay = delays[retry]
    if (outcome.ok || delay === undefined) return
    setTimeout(() => {
      if (db.$client.open) deliver(db, target, payload, tuning, retry + 1)
    }, delay).unref()
  })
}

/** Posts each change to every registration that wants it. Returns the stop. */
export function startWebhookDelivery(db: Db, feed: ChangeFeed, tuning: DeliveryTuning = {}): () => void {
  return feed.listen((event: ChangeEvent) => {
    const body = JSON.stringify(event)
    for (const target of webhooksFor(db, event)) deliver(db, target, { id: event.id, type: event.type, body }, tuning)
  })
}

/** The settings screen's Test button: one `ping`, no retries, answered with how it went. */
export function sendTestDelivery(db: Db, target: WebhookTarget, tuning: DeliveryTuning = {}): Promise<WebhookDelivery> {
  const id = randomUUID()
  const body = JSON.stringify({ id, type: 'ping', occurredAt: new Date().toISOString(), data: {} })
  return attempt(db, target, { id, type: 'ping', body }, tuning)
}
