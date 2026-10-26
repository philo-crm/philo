/*
 * Server-Sent Events over a plain Response, for clients that read with `fetch`
 * — `EventSource` cannot send the bearer token. Shared by the notification
 * stream (push/live.ts) and the change stream (events/routes.ts).
 */

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

/** Writes one event: its name and a JSON body. */
export type SendEvent = (name: string, data: unknown) => void

/** Wires `send` to a source; returns what stops it. */
export type Subscribe = (send: SendEvent) => () => void

export function eventStream(subscribe: Subscribe, tuning: LiveTuning = {}): Response {
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
      const unlisten = subscribe((name, data) => send(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
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
