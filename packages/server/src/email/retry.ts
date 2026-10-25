/**
 * Retry policy for a failed send — ADR-0004 makes email the guaranteed
 * notification channel, and one attempt does not make it one. Greylisting is
 * the case this is shaped around: an ordinary receiver refuses a first-time
 * sender with a 4xx and accepts the same message minutes later, so a single
 * attempt turns a routine defence into a permanently missed lead.
 */

/**
 * Attempts per trigger before Philo stops and says so on the lead's timeline.
 * Five over the curve below spans roughly a quarter of an hour, which covers
 * greylisting and a brief provider wobble without hammering a server that has
 * made up its mind.
 */
export const MAX_SEND_ATTEMPTS = 5

/** First wait after a failure. Doubles per attempt, capped below. */
export const RETRY_BASE_DELAY_MS = 60_000
export const RETRY_MAX_DELAY_MS = 30 * 60 * 1000

/**
 * How far back a boot sweep looks for leads with an email still owed. The
 * retry schedule lives in memory, so a restart mid-backoff forgets it; this is
 * what makes the guarantee survive one. A day is long enough to cover a
 * restart, an overnight outage, or an operator configuring SMTP the morning
 * after their first lead — and short enough that it never resurrects an
 * acknowledgment so late it would confuse the person who gets it.
 */
export const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000

/** Ceiling on one sweep, so a burst of leads cannot make a boot crawl. */
export const SWEEP_LIMIT = 500

/**
 * How far a wait is spread either side of the curve. A boot sweep can book
 * hundreds of chains inside a second when the mail server is refusing
 * connections outright, and without this they stay in lockstep for every
 * attempt after that — arriving as one burst at a server that just came back.
 */
export const RETRY_JITTER_RATIO = 0.25

export interface RetryTuning {
  baseDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  /** Zero makes the curve exact, which is what the tests assert against. */
  jitterRatio?: number
}

export function maxAttempts(tuning: RetryTuning = {}): number {
  return tuning.maxAttempts ?? MAX_SEND_ATTEMPTS
}

/**
 * Wait before the next attempt. `attempt` is the one that just failed, so the
 * first wait is the base delay: 1, 2, 4, 8 minutes, then the cap — each spread
 * by the jitter above.
 */
export function retryDelayMs(
  attempt: number,
  tuning: RetryTuning = {},
  random: () => number = Math.random,
): number {
  const base = tuning.baseDelayMs ?? RETRY_BASE_DELAY_MS
  const max = tuning.maxDelayMs ?? RETRY_MAX_DELAY_MS
  const delay = Math.min(base * 2 ** (attempt - 1), max)

  const ratio = tuning.jitterRatio ?? RETRY_JITTER_RATIO
  if (ratio <= 0) return delay
  const spread = delay * ratio
  return Math.round(delay - spread + random() * spread * 2)
}

/** How a delayed retry is booked. Tests pass one that runs immediately. */
export type ScheduleRetry = (run: () => void, delayMs: number) => void

/**
 * `unref` so a pending retry cannot hold the process open. A shutdown with a
 * retry booked drops it; the next boot's sweep is what picks the lead back up.
 */
export const scheduleWithTimer: ScheduleRetry = (run, delayMs) => {
  setTimeout(run, delayMs).unref()
}
