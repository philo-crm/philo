export interface RateLimitDecision {
  allowed: boolean
  /** Seconds until the window resets. Zero when allowed. */
  retryAfterSeconds: number
}

/** Above this many tracked keys, recording a failure also sweeps the expired ones. */
const PRUNE_THRESHOLD = 1024

interface Window {
  failures: number
  resetAt: number
}

/**
 * Fixed-window failure counter, held in process. DESIGN.md (Architecture) is one
 * process and one SQLite file, so there is no second instance to share state
 * with and nothing to put in the database.
 *
 * Only failures count, and a success clears the key. Counting every attempt
 * would let anyone who knows an email address burn that account's budget and
 * lock its owner out.
 */
export class FailureLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #windows = new Map<string, Window>()

  constructor(limit: number, windowMs: number) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Does not mutate: call it before doing the expensive work, not after. */
  check(key: string, now = Date.now()): RateLimitDecision {
    const window = this.#windows.get(key)
    if (window === undefined || window.resetAt <= now) return { allowed: true, retryAfterSeconds: 0 }
    if (window.failures < this.#limit) return { allowed: true, retryAfterSeconds: 0 }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) }
  }

  recordFailure(key: string, now = Date.now()): void {
    this.#pruneIfCrowded(now)
    const window = this.#windows.get(key)
    if (window === undefined || window.resetAt <= now) {
      this.#windows.set(key, { failures: 1, resetAt: now + this.#windowMs })
      return
    }
    window.failures += 1
  }

  reset(key: string): void {
    this.#windows.delete(key)
  }

  /**
   * The map only grows when logins fail, and a key is dead once its window
   * closes. Sweeping on the way past a threshold bounds it without a timer that
   * would hold the process open.
   */
  #pruneIfCrowded(now: number): void {
    if (this.#windows.size < PRUNE_THRESHOLD) return
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key)
    }
  }
}
