import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
} from '../src/auth/password.ts'
import { ConcurrencyGate, FailureThrottle } from '../src/auth/rate-limit.ts'
import { SIGNING_KEY_FILENAME, loadOrCreateSigningKey } from '../src/oauth/signing-key.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'philo-secret-'))
  dirs.push(dir)
  return dir
}

describe('password hashing', () => {
  it('produces an argon2id hash that verifies', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    await expect(verifyPassword(hash, 'correct-horse-battery-staple')).resolves.toBe(true)
  })

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple')
    await expect(verifyPassword(hash, 'correct-horse-battery-stapl')).resolves.toBe(false)
  })

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([hashPassword('same-password-twice'), hashPassword('same-password-twice')])
    expect(first).not.toBe(second)
  })

  it('treats a malformed stored hash as a failed login rather than throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'correct-horse-battery-staple')).resolves.toBe(false)
    await expect(verifyPassword('', 'correct-horse-battery-staple')).resolves.toBe(false)
  })

  it('bounds the password length it will hash', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12)
    expect(MAX_PASSWORD_LENGTH).toBeGreaterThan(MIN_PASSWORD_LENGTH)
  })
})

describe('id_token signing key', () => {
  it('generates a key on first call and reuses it after', () => {
    const dir = tempDir()
    const first = loadOrCreateSigningKey(dir)
    expect(first.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })
    expect(loadOrCreateSigningKey(dir).kid).toBe(first.kid)
  })

  it('writes the key owner-readable only', () => {
    const dir = tempDir()
    loadOrCreateSigningKey(dir)
    const mode = statSync(join(dir, SIGNING_KEY_FILENAME)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('replaces a key file left half-written by an interrupted write', () => {
    const dir = tempDir()
    const path = join(dir, SIGNING_KEY_FILENAME)
    writeFileSync(path, '{"kty":')
    const key = loadOrCreateSigningKey(dir)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(loadOrCreateSigningKey(dir).kid).toBe(key.kid)
  })

  it('never puts the private half in what it publishes', () => {
    expect(loadOrCreateSigningKey(tempDir()).publicJwk).not.toHaveProperty('d')
  })

  it('gives different data dirs different keys', () => {
    expect(loadOrCreateSigningKey(tempDir()).kid).not.toBe(loadOrCreateSigningKey(tempDir()).kid)
  })
})

describe('FailureThrottle', () => {
  const OPTIONS = { windowMs: 60_000, freeAttempts: 2, baseDelayMs: 100, maxDelayMs: 800 }

  function throttle(): FailureThrottle {
    return new FailureThrottle(OPTIONS)
  }

  it('charges nothing for a key that has never been used', () => {
    expect(throttle().delayFor('a', 0)).toBe(0)
  })

  it('charges nothing within the free allowance', () => {
    const t = throttle()
    t.recordAttempt('a', 0)
    expect(t.delayFor('a', 0)).toBe(0)
    t.recordAttempt('a', 0)
    expect(t.delayFor('a', 0)).toBe(0)
  })

  it('doubles the delay per attempt past the allowance, up to the ceiling', () => {
    const t = throttle()
    for (let i = 0; i < OPTIONS.freeAttempts; i += 1) t.recordAttempt('a', 0)

    const delays: number[] = []
    for (let i = 0; i < 6; i += 1) {
      t.recordAttempt('a', 0)
      delays.push(t.delayFor('a', 0))
    }
    expect(delays).toEqual([100, 200, 400, 800, 800, 800])
  })

  /**
   * The property that makes this safe to run in front of the only credential:
   * however many attempts a key has made, the answer is a wait, never a refusal.
   */
  it('never reports an unbounded wait', () => {
    const t = throttle()
    for (let i = 0; i < 1000; i += 1) t.recordAttempt('a', 0)
    expect(t.delayFor('a', 0)).toBe(OPTIONS.maxDelayMs)
  })

  it('keys independently', () => {
    const t = throttle()
    for (let i = 0; i < 5; i += 1) t.recordAttempt('a', 0)
    expect(t.delayFor('a', 0)).toBeGreaterThan(0)
    expect(t.delayFor('b', 0)).toBe(0)
  })

  it('forgives once the window closes', () => {
    const t = throttle()
    for (let i = 0; i < 5; i += 1) t.recordAttempt('a', 0)
    expect(t.delayFor('a', OPTIONS.windowMs - 1)).toBeGreaterThan(0)
    expect(t.delayFor('a', OPTIONS.windowMs)).toBe(0)
  })

  it('restarts the window on each attempt, so pacing does not earn a free budget', () => {
    const t = throttle()
    for (let i = 0; i < 5; i += 1) t.recordAttempt('a', 0)
    // An attempt just before the window would have closed carries it forward.
    t.recordAttempt('a', OPTIONS.windowMs - 1)
    expect(t.delayFor('a', OPTIONS.windowMs)).toBeGreaterThan(0)
  })

  it('clears a key on reset, so a success wipes the accumulated delay', () => {
    const t = throttle()
    for (let i = 0; i < 5; i += 1) t.recordAttempt('a', 0)
    t.reset('a')
    expect(t.delayFor('a', 0)).toBe(0)
  })

  it('bounds its own size against keys an attacker chooses', () => {
    const t = throttle()
    // One key per email tried. Sweeping only reclaims closed windows, so without
    // an eviction path this map would grow with the flood.
    for (let i = 0; i < 5000; i += 1) t.recordAttempt(`email:${i}@example.com`, 0)

    // The most recent key is still tracked, so eviction has not made the throttle
    // useless — it has only forgotten the oldest.
    t.recordAttempt('email:4999@example.com', 0)
    for (let i = 0; i < 5; i += 1) t.recordAttempt('email:4999@example.com', 0)
    expect(t.delayFor('email:4999@example.com', 0)).toBeGreaterThan(0)
    expect(t.delayFor('email:0@example.com', 0)).toBe(0)
  })
})

describe('ConcurrencyGate', () => {
  it('admits up to the limit and refuses past it', () => {
    const gate = new ConcurrencyGate(2)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
  })

  it('frees a slot on release', () => {
    const gate = new ConcurrencyGate(1)
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
    gate.release()
    expect(gate.tryAcquire()).toBe(true)
  })

  it('does not accumulate credit from extra releases', () => {
    const gate = new ConcurrencyGate(1)
    gate.release()
    gate.release()
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
  })
})
