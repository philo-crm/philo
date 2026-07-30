/** Above this many tracked keys, recording a failure also sweeps the expired ones. */
const PRUNE_THRESHOLD = 1024

interface Window {
  failures: number
  resetAt: number
}

export interface ThrottleOptions {
  /** How long a key's failures are remembered. */
  windowMs: number
  /** Failures within the window that cost nothing, so ordinary typos do not sting. */
  freeAttempts: number
  /** Delay after the first non-free failure; doubles per failure after that. */
  baseDelayMs: number
  /** Ceiling on the delay, so a legitimate sign-in is never worse than this. */
  maxDelayMs: number
}

/**
 * Per-key failure tracker that answers with a *delay*, never a refusal.
 *
 * Refusing outright is the obvious design and it is wrong here: the deployment in
 * DESIGN.md (Architecture) sits behind a TLS-terminating proxy, so every request
 * arrives from one address and shares one key. A hard cap on that key would let
 * any unauthenticated caller spend ten junk requests to deny the operator the
 * only credential Philo has — indefinitely, since the cap outlives the attempts
 * that tripped it. Slowing an attacker to a crawl costs them everything and costs
 * the operator a couple of seconds.
 *
 * The work an attacker can actually commission is bounded separately, by
 * `ConcurrencyGate` — a delay cannot bound the first burst, because every request
 * in it sees the same low failure count.
 */
export class FailureThrottle {
  readonly #options: ThrottleOptions
  readonly #windows = new Map<string, Window>()

  constructor(options: ThrottleOptions) {
    this.#options = options
  }

  /** Milliseconds to wait before spending real work on this key. */
  delayFor(key: string, now = Date.now()): number {
    const window = this.#windows.get(key)
    if (window === undefined || window.resetAt <= now) return 0
    const overage = window.failures - this.#options.freeAttempts
    if (overage <= 0) return 0
    const delay = this.#options.baseDelayMs * 2 ** (overage - 1)
    return Math.min(delay, this.#options.maxDelayMs)
  }

  recordFailure(key: string, now = Date.now()): void {
    this.#pruneIfCrowded(now)
    const window = this.#windows.get(key)
    if (window === undefined || window.resetAt <= now) {
      this.#windows.set(key, { failures: 1, resetAt: now + this.#options.windowMs })
      return
    }
    window.failures += 1
    // Each failure restarts the window: an attacker pacing themselves to just
    // outside it should not get their budget back for free.
    window.resetAt = now + this.#options.windowMs
  }

  reset(key: string): void {
    this.#windows.delete(key)
  }

  /**
   * The map only grows when attempts fail, and a key is dead once its window
   * closes. Sweeping past a threshold bounds it without a timer that would hold
   * the process open.
   */
  #pruneIfCrowded(now: number): void {
    if (this.#windows.size < PRUNE_THRESHOLD) return
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key)
    }
  }
}

/**
 * Caps how many password hashes run at once. argon2id is deliberately expensive
 * in memory, so an unauthenticated endpoint that hashes on demand is an
 * amplifier: without this, one burst of concurrent logins reserves 19 MiB apiece.
 *
 * Unlike a failure cap this cannot lock anyone out — a slot frees as soon as a
 * hash finishes, in tens of milliseconds — so refusing here is safe.
 */
export class ConcurrencyGate {
  readonly #limit: number
  #inFlight = 0

  constructor(limit: number) {
    this.#limit = limit
  }

  tryAcquire(): boolean {
    if (this.#inFlight >= this.#limit) return false
    this.#inFlight += 1
    return true
  }

  release(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1)
  }
}
