import { createHmac, randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { Db } from '../db/index.ts'
import type { ChangeEvent, ChangeFeed } from '../events/feed.ts'
import { findLead } from '../leads/service.ts'
import { VERSION } from '../version.ts'
import { findWebhookTarget, recordDelivery, webhooksFor, type WebhookDelivery, type WebhookTarget } from './service.ts'

export interface DeliveryTuning {
  timeoutMs?: number | undefined
  /** Waits before each retry; its length is how many retries there are. */
  retryDelaysMs?: readonly number[] | undefined
  /** Resolves a host to every address it has. Tests substitute their own. */
  resolve?: ((host: string) => Promise<string[]>) | undefined
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

const REFUSED = 'address not allowed'

async function resolveAll(host: string): Promise<string[]> {
  const found = await dnsLookup(host, { all: true, verbatim: true })
  return found.map((entry) => entry.address)
}

/**
 * The socket's own resolver, refusing a host if any address it has is
 * forbidden. Because the connection uses exactly what this returns, a name
 * cannot pass a check and then resolve somewhere else to connect.
 */
function guardedLookup(resolve: (host: string) => Promise<string[]>): LookupFunction {
  return (host, options, callback) => {
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0) return callback(new Error(`no address for ${host}`), '', 0)
        if (addresses.some(isForbidden)) return callback(new Error(REFUSED), '', 0)
        const entries = addresses.map((address) => ({ address, family: isIP(address) }))
        if (options.all === true) return (callback as unknown as (e: null, a: typeof entries) => void)(null, entries)
        const [first] = entries
        callback(null, first!.address, first!.family)
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, '', 0),
    )
  }
}

/** One POST; answers the status. A redirect is a status like any other — it is never followed. */
function post(url: URL, headers: Record<string, string>, body: string, tuning: DeliveryTuning): Promise<number> {
  // An address in the URL is never looked up, so it is checked here instead.
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) !== 0 && isForbidden(literal)) return Promise.reject(new Error(REFUSED))
  const options: RequestOptions = {
    method: 'POST',
    headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
    lookup: guardedLookup(tuning.resolve ?? resolveAll),
    signal: AbortSignal.timeout(tuning.timeoutMs ?? TIMEOUT_MS),
  }
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, (res) => {
      // Nothing in the answer is used; drain it so the socket is released.
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end(body)
  })
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
    status = await post(
      new URL(target.url),
      {
        ...(target.authHeader && { [target.authHeader.name]: target.authHeader.value }),
        'Content-Type': 'application/json',
        'User-Agent': `philo/${VERSION}`,
        'X-Philo-Event': payload.type,
        'X-Philo-Delivery': payload.id,
        'X-Philo-Timestamp': timestamp,
        'X-Philo-Signature': signPayload(target.secret, timestamp, payload.body),
      },
      payload.body,
      tuning,
    )
    if (status < 200 || status >= 300) error = `HTTP ${status}`
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

/**
 * The event as a retry may still send it: only to a registration that still
 * wants it, and with the lead as it now stands. A lead deleted or quarantined
 * since is not sent again — its erasure must not be undone by a retry.
 */
function refreshed(db: Db, event: ChangeEvent, targetId: number): ChangeEvent | undefined {
  if (!webhooksFor(db, event).some((target) => target.id === targetId)) return undefined
  const { lead } = event.data
  if (lead === undefined) return event
  const current = findLead(db, lead.id)
  if (current === undefined || current.isSpam) return undefined
  return { ...event, data: { ...event.data, lead: current } }
}

function deliver(db: Db, target: WebhookTarget, event: ChangeEvent, tuning: DeliveryTuning, retry = 0): void {
  const payload = { id: event.id, type: event.type, body: JSON.stringify(event) }
  void attempt(db, target, payload, tuning).then((outcome) => {
    const delays = tuning.retryDelaysMs ?? RETRY_DELAYS_MS
    const delay = delays[retry]
    if (outcome.ok || delay === undefined) return
    setTimeout(() => {
      if (!db.$client.open) return
      const current = findWebhookTarget(db, target.id)
      const again = current && refreshed(db, event, target.id)
      if (current && again) deliver(db, current, again, tuning, retry + 1)
    }, delay).unref()
  })
}

/** Posts each change to every registration that wants it. Returns the stop. */
export function startWebhookDelivery(db: Db, feed: ChangeFeed, tuning: DeliveryTuning = {}): () => void {
  return feed.listen((event: ChangeEvent) => {
    for (const target of webhooksFor(db, event)) deliver(db, target, event, tuning)
  })
}

/** The settings screen's Test button: one `ping`, no retries, answered with how it went. */
export function sendTestDelivery(db: Db, target: WebhookTarget, tuning: DeliveryTuning = {}): Promise<WebhookDelivery> {
  const id = randomUUID()
  const body = JSON.stringify({ id, type: 'ping', occurredAt: new Date().toISOString(), data: {} })
  return attempt(db, target, { id, type: 'ping', body }, tuning)
}
