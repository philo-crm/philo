import { setTimeout as sleep } from 'node:timers/promises'

/** Above this many tracked keys, recording a failure also sweeps the expired ones. */
const PRUNE_THRESHOLD = 1024

interface Window {
  attempts: number
  resetAt: number
}

export interface ThrottleOptions {
  /** How long a key's attempts are remembered. */
  windowMs: number
  /** Attempts within the window that cost nothing, so ordinary typos do not sting. */
  freeAttempts: number
  /** Delay after the first non-free attempt; doubles per attempt after that. */
  baseDelayMs: number
  /** Ceiling on the delay, so a legitimate sign-in is never worse than this. */
  maxDelayMs: number
}

/**
 * Per-key attempt tracker that answers with a *delay*, never a refusal.
 *
 * Refusing outright is the obvious design and it is wrong here: the deployment in
 * DESIGN.md (Architecture) sits behind a TLS-terminating proxy, and unless the
 * operator sets `PHILO_TRUSTED_PROXY` every request arrives from one address and
 * shares one key. A hard cap on that key would let any unauthenticated caller
 * spend ten junk requests to deny the operator the only credential Philo has —
 * indefinitely, since the cap outlives the attempts that tripped it. Slowing an
 * attacker to a crawl costs them everything and costs the operator a couple of
 * seconds. The delay is right either way, so nothing here depends on that setting
 * being on.
 *
 * Counting *attempts* rather than failures, before the work rather than after, is
 * what makes the delay bite under load. Counting failures afterwards would let
 * every request in a concurrent burst read the same low count and pay the same
 * small delay — turning a half-per-second serial limit into hundreds per second.
 * A success calls `reset`, so a legitimate user never accumulates anything.
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
    const overage = window.attempts - this.#options.freeAttempts
    if (overage <= 0) return 0
    const wait = this.#options.baseDelayMs * 2 ** (overage - 1)
    return Math.min(wait, this.#options.maxDelayMs)
  }

  /** Call before the expensive work, so concurrent callers see each other. */
  recordAttempt(key: string, now = Date.now()): void {
    this.#pruneIfCrowded(now)
    const window = this.#windows.get(key)
    if (window === undefined || window.resetAt <= now) {
      this.#windows.set(key, { attempts: 1, resetAt: now + this.#options.windowMs })
      return
    }
    window.attempts += 1
    // Each attempt restarts the window: an attacker pacing themselves to just
    // outside it should not get their budget back for free.
    window.resetAt = now + this.#options.windowMs
  }

  reset(key: string): void {
    this.#windows.delete(key)
  }

  /**
   * Keys are attacker-supplied (one per email tried), so the map needs a bound.
   * A sweep only reclaims closed windows, so it cannot keep up with a flood on its
   * own; past the threshold the oldest windows go regardless. Evicting a window
   * only ever forgives attempts, and the caller's other key still throttles.
   */
  #pruneIfCrowded(now: number): void {
    if (this.#windows.size < PRUNE_THRESHOLD) return
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key)
    }
    // Map iteration is insertion-ordered, so this drops the least recently created.
    for (const key of this.#windows.keys()) {
      if (this.#windows.size <= PRUNE_THRESHOLD) break
      this.#windows.delete(key)
    }
  }
}

/**
 * Caps how many password hashes run at once. argon2id is deliberately expensive
 * in memory, so an unauthenticated endpoint that hashes on demand is an
 * amplifier: without this, one burst of concurrent logins reserves 19 MiB apiece.
 *
 * Unlike a cap on attempts this cannot lock anyone out — a slot frees as soon as
 * a hash finishes, in tens of milliseconds — so refusing here is safe.
 *
 * Admission is a scramble rather than a queue, so a login arriving mid-flood can
 * be shed and have to retry. Reviewed and accepted for now: it outlasts no flood,
 * and because callers are throttled before they reach this point a slot is
 * usually free anyway. A bounded FIFO queue is the upgrade if real deployments
 * ever see it.
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

/**
 * Waits out a `FailureThrottle` delay, but stops early if the caller hangs up.
 * Without the signal an attacker could fire and forget: they release everything
 * while the server keeps a request context and a timer alive for the full delay,
 * once per guess.
 */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined)
  } catch {
    // Aborted. The caller checks the signal; nothing here needs to distinguish.
  }
}
