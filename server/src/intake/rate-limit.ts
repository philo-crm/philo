/** Above this many tracked keys, taking a token also sweeps the refilled ones. */
const PRUNE_THRESHOLD = 1024

export interface TokenBucketOptions {
  /** Tokens available to a burst before the refill rate is what governs. */
  capacity: number
  /** Tokens returned per second once the burst is spent. */
  refillPerSecond: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

/**
 * Per-key token bucket. Refuses, unlike the login throttle, and the difference
 * is deliberate.
 *
 * Login must never refuse a correct password, because a refusal there locks the
 * operator out of the only credential Philo has. Intake has no credential to
 * protect and a real cost to admitting everything — every accepted submission is
 * a row, a notification email, and a push. So this one says no.
 *
 * What keeps that from becoming its own denial of service — behind a reverse
 * proxy every submission shares one key (see clientKey) — is continuous refill:
 * a refused request consumes nothing and the bucket recovers on a timer, so the
 * worst a flood can do is make a real applicant's submission wait seconds, not
 * be turned away until the flood stops. A window that reset on every attempt,
 * or a cap that outlived the requests that tripped it, would not hold that line.
 */
export class TokenBucket {
  readonly #options: TokenBucketOptions
  readonly #buckets = new Map<string, Bucket>()

  constructor(options: TokenBucketOptions) {
    this.#options = options
  }

  /**
   * Spends a token if one is available. False means the caller is over budget —
   * and records nothing, which is what keeps a refusal from extending itself.
   */
  take(key: string, now = Date.now()): boolean {
    this.#pruneIfCrowded(now)
    const tokens = this.#peek(key, now)
    if (tokens < 1) return false
    this.#buckets.set(key, { tokens: tokens - 1, updatedAt: now })
    return true
  }

  /**
   * Whole seconds until the next token, for `Retry-After`. Always a finite value
   * of at least 1 — a header of `Infinity` from a bucket tuned not to refill
   * would be a malformed answer, and a caller told to wait a minute and retry is
   * a truthful one.
   */
  retryAfterSeconds(key: string, now = Date.now()): number {
    if (this.#options.refillPerSecond <= 0) return 60
    const missing = 1 - this.#peek(key, now)
    if (missing <= 0) return 1
    return Math.max(1, Math.ceil(missing / this.#options.refillPerSecond))
  }

  /** Tokens the key would have now. Pure: spends nothing, records nothing. */
  #peek(key: string, now: number): number {
    const bucket = this.#buckets.get(key)
    if (bucket === undefined) return this.#options.capacity
    // Clamped at zero so a clock that jumps backwards cannot hand out credit.
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000
    return Math.min(
      this.#options.capacity,
      bucket.tokens + elapsedSeconds * this.#options.refillPerSecond,
    )
  }

  /**
   * Keys are attacker-supplied (one per source address), so the map needs a
   * bound. Dropping a full bucket costs nothing — an absent key is a full
   * bucket — and dropping a drained one only ever forgives, which is the safe
   * direction for a limiter that must not turn real submissions away.
   */
  #pruneIfCrowded(now: number): void {
    if (this.#buckets.size < PRUNE_THRESHOLD) return
    // Deleting during iteration is defined behaviour for a Map: a removed entry
    // is simply not visited again.
    for (const key of this.#buckets.keys()) {
      if (this.#peek(key, now) >= this.#options.capacity) this.#buckets.delete(key)
    }
    // Map iteration is insertion-ordered, so this drops the least recently created.
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= PRUNE_THRESHOLD) break
      this.#buckets.delete(key)
    }
  }
}
