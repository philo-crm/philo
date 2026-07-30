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

  /** Spends a token if one is available. False means the caller is over budget. */
  take(key: string, now = Date.now()): boolean {
    this.#pruneIfCrowded(now)
    const bucket = this.#refill(key, now)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    this.#buckets.set(key, bucket)
    return true
  }

  /** Whole seconds until the next token, for `Retry-After`. Always at least 1. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const bucket = this.#refill(key, now)
    if (bucket.tokens >= 1) return 1
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.#options.refillPerSecond))
  }

  #refill(key: string, now: number): Bucket {
    const bucket = this.#buckets.get(key)
    if (bucket === undefined) return { tokens: this.#options.capacity, updatedAt: now }
    // Clamped at zero so a clock that jumps backwards cannot hand out credit.
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(
      this.#options.capacity,
      bucket.tokens + elapsedSeconds * this.#options.refillPerSecond,
    )
    bucket.updatedAt = now
    return bucket
  }

  /**
   * Keys are attacker-supplied (one per source address), so the map needs a
   * bound. Dropping a full bucket costs nothing — an absent key is a full
   * bucket — and dropping a drained one only ever forgives, which is the safe
   * direction for a limiter that must not turn real submissions away.
   */
  #pruneIfCrowded(now: number): void {
    if (this.#buckets.size < PRUNE_THRESHOLD) return
    for (const [key, bucket] of this.#buckets) {
      const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000
      const refilled = bucket.tokens + elapsedSeconds * this.#options.refillPerSecond
      if (refilled >= this.#options.capacity) this.#buckets.delete(key)
    }
    // Map iteration is insertion-ordered, so this drops the least recently created.
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size <= PRUNE_THRESHOLD) break
      this.#buckets.delete(key)
    }
  }
}
