/*
 * Keeping a screen current while it is open — ADR-0010. The server streams every
 * change it commits; a screen hears the ones it cares about and refetches.
 * Refetching rather than patching from the event keeps one source of truth for
 * each screen's shape: the request it already makes.
 */

import { useEffect, useRef } from 'react'
import { streamChanges, type ChangeEvent } from './api.ts'

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 60_000

/**
 * Holds a stream open until `signal` aborts. The server ends each stream every
 * few minutes so the next connect carries a fresh token; a dropped connection
 * backs off rather than hammering a server that is down.
 */
export async function holdStream(open: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  let delay = RECONNECT_MIN_MS
  while (!signal.aborted) {
    try {
      await open(signal)
      delay = RECONNECT_MIN_MS
    } catch {
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
    await wait(delay, signal)
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Changes arriving this close together are handed over as one batch: a stage
 * reorder or a burst of form submissions is one refetch, not several.
 */
export const LIVE_BATCH_MS = 250

/**
 * Calls `onChanges` with each batch of changes while mounted, scoped to one
 * funnel when `funnelId` is given. `onChanges` may change every render; the
 * stream is reopened only when the funnel does.
 */
export function useLiveChanges(onChanges: (events: ChangeEvent[]) => void, funnelId?: number): void {
  const handler = useRef(onChanges)
  handler.current = onChanges

  useEffect(() => {
    const controller = new AbortController()
    let pending: ChangeEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      const batch = pending
      pending = []
      if (!controller.signal.aborted) handler.current(batch)
    }
    void holdStream(
      (signal) =>
        streamChanges(
          (event) => {
            pending.push(event)
            timer ??= setTimeout(flush, LIVE_BATCH_MS)
          },
          signal,
          funnelId,
        ),
      controller.signal,
    )
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [funnelId])
}
