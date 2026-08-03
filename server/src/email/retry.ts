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

export interface RetryTuning {
  baseDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

export function maxAttempts(tuning: RetryTuning = {}): number {
  return tuning.maxAttempts ?? MAX_SEND_ATTEMPTS
}

/**
 * Wait before the next attempt. `attempt` is the one that just failed, so the
 * first wait is the base delay: 1, 2, 4, 8 minutes, then the cap.
 *
 * No jitter, deliberately. Jitter exists to stop many senders retrying in
 * lockstep, and a single-tenant instance sending a handful of messages a day is
 * the one caller its own mail server has.
 */
export function retryDelayMs(attempt: number, tuning: RetryTuning = {}): number {
  const base = tuning.baseDelayMs ?? RETRY_BASE_DELAY_MS
  const max = tuning.maxDelayMs ?? RETRY_MAX_DELAY_MS
  return Math.min(base * 2 ** (attempt - 1), max)
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
