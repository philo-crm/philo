/*
 * The in-app fallback for push. A browser with no push service to subscribe to
 * — Brave with Google's push messaging switched off, a de-Googled Chromium —
 * can still show a notification while Philo is open, if something tells it a
 * lead arrived. This is that something: a Server-Sent Events stream fed by the
 * same hook as email and push, so it fires for exactly the leads they do.
 *
 * In memory, deliberately. One instance per business means one process, and a
 * listener exists only while a tab holds the stream open — there is nothing to
 * persist, and a lead that arrives while no tab is open still gets its email.
 */

import type { Db } from '../db/index.ts'
import { getLead } from '../leads/service.ts'
import type { LeadCreatedHook } from '../notify.ts'
import { buildLeadNotification, type DeclarativeNotification } from './service.ts'

/** What a stream event carries: the push payload's notification, unchanged. */
export type LiveNotification = DeclarativeNotification['notification']

type Listener = (notification: LiveNotification) => void

export class LiveFeed {
  readonly #listeners = new Set<Listener>()

  /** Returns the unsubscribe. */
  listen(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  publish(notification: LiveNotification): void {
    // A listener whose stream has closed may remove itself mid-loop, which a Set
    // iterator tolerates.
    for (const listener of this.#listeners) {
      try {
        listener(notification)
      } catch (error: unknown) {
        console.error('live feed listener failed', error)
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size
  }
}

export interface LiveHookDeps {
  db: Db
  appUrl: string
  feed: LiveFeed
}

/** What `AppOptions.onLeadCreated` is wired to beside email and push — see boot.ts. */
export function createLiveLeadHook(deps: LiveHookDeps): LeadCreatedHook {
  return (created) => {
    if (created.isSpam) return
    const lead = getLead(deps.db, created.id)
    if (lead === undefined || lead.isSpam) return
    deps.feed.publish(buildLeadNotification(lead, deps.appUrl).notification)
  }
}

export interface LiveTuning {
  /** A comment line this often, so an idle proxy does not drop the connection. */
  heartbeatMs?: number
  /**
   * The stream ends after this long and the client reconnects. The credential
   * is checked once, at connect; this bounds how long a revoked or expired one
   * keeps receiving — well inside the access token's own hour.
   */
  maxDurationMs?: number
}

const HEARTBEAT_MS = 25_000
const MAX_DURATION_MS = 15 * 60 * 1000

function noop(): void {}

export function liveStream(feed: LiveFeed, tuning: LiveTuning = {}): Response {
  const encoder = new TextEncoder()
  let cleanup: () => void = noop

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          cleanup()
        }
      }
      const unlisten = feed.listen((notification) => {
        send(`event: lead\ndata: ${JSON.stringify(notification)}\n\n`)
      })
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), tuning.heartbeatMs ?? HEARTBEAT_MS)
      const deadline = setTimeout(() => {
        cleanup()
        try {
          controller.close()
        } catch {
          // Already cancelled by the client.
        }
      }, tuning.maxDurationMs ?? MAX_DURATION_MS)
      cleanup = () => {
        unlisten()
        clearInterval(heartbeat)
        clearTimeout(deadline)
      }
      // Something on the wire at once, so the headers make it through any proxy
      // that waits for a first byte.
      send(': connected\n\n')
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // nginx buffers proxied responses by default, which would hold every event.
      'X-Accel-Buffering': 'no',
    },
  })
}
