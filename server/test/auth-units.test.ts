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
import { FailureLimiter } from '../src/auth/rate-limit.ts'
import { SESSION_KEY_FILENAME, loadOrCreateSessionKey } from '../src/auth/session-key.ts'
import { generateSessionToken, hashSessionToken } from '../src/auth/session.ts'

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

describe('session tokens', () => {
  it('generates distinct, URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateSessionToken))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('hashes deterministically and irreversibly', () => {
    const token = generateSessionToken()
    expect(hashSessionToken(token)).toBe(hashSessionToken(token))
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSessionToken(token)).not.toContain(token)
  })
})

describe('session signing key', () => {
  it('generates a key on first call and reuses it after', () => {
    const dir = tempDir()
    const first = loadOrCreateSessionKey(dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(loadOrCreateSessionKey(dir)).toBe(first)
  })

  it('writes the key owner-readable only', () => {
    const dir = tempDir()
    loadOrCreateSessionKey(dir)
    const mode = statSync(join(dir, SESSION_KEY_FILENAME)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('replaces an empty key file left behind by an interrupted write', () => {
    const dir = tempDir()
    const path = join(dir, SESSION_KEY_FILENAME)
    writeFileSync(path, '   \n')
    const key = loadOrCreateSessionKey(dir)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(path, 'utf8').trim()).toBe(key)
  })

  it('gives different data dirs different keys', () => {
    expect(loadOrCreateSessionKey(tempDir())).not.toBe(loadOrCreateSessionKey(tempDir()))
  })
})

describe('FailureLimiter', () => {
  const WINDOW_MS = 60_000

  it('allows a key that has never failed', () => {
    expect(new FailureLimiter(3, WINDOW_MS).check('a', 0).allowed).toBe(true)
  })

  it('allows up to the limit and blocks past it', () => {
    const limiter = new FailureLimiter(3, WINDOW_MS)
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('a', 0).allowed).toBe(true)
      limiter.recordFailure('a', 0)
    }
    const blocked = limiter.check('a', 0)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(60)
  })

  it('keys independently', () => {
    const limiter = new FailureLimiter(1, WINDOW_MS)
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', 0).allowed).toBe(false)
    expect(limiter.check('b', 0).allowed).toBe(true)
  })

  it('forgives once the window closes', () => {
    const limiter = new FailureLimiter(1, WINDOW_MS)
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', WINDOW_MS - 1).allowed).toBe(false)
    expect(limiter.check('a', WINDOW_MS).allowed).toBe(true)
  })

  it('clears a key on reset, so a success restores the full budget', () => {
    const limiter = new FailureLimiter(1, WINDOW_MS)
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', 0).allowed).toBe(false)
    limiter.reset('a')
    expect(limiter.check('a', 0).allowed).toBe(true)
  })

  it('reports a retry-after of at least one second, never zero', () => {
    const limiter = new FailureLimiter(1, WINDOW_MS)
    limiter.recordFailure('a', 0)
    expect(limiter.check('a', WINDOW_MS - 1).retryAfterSeconds).toBe(1)
  })
})
