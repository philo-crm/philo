import { hash, verify, type Algorithm, type Options } from '@node-rs/argon2'

/**
 * `Algorithm.Argon2id` spelled numerically. The binding declares `Algorithm` as
 * an ambient const enum, which `isolatedModules` forbids reading.
 */
const ARGON2ID = 2 as Algorithm

/**
 * OWASP's argon2id baseline: 19 MiB, two passes, one lane. Memory is what makes
 * a stolen hash expensive to crack in bulk, so the cost sits there rather than
 * in the iteration count.
 */
const HASH_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

export const MIN_PASSWORD_LENGTH = 12

/**
 * argon2 accepts any length, so the cap is a denial-of-service guard: without it
 * a megabyte-long password would bill a megabyte of hashing to one request.
 */
export const MAX_PASSWORD_LENGTH = 1024

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS)
}

/**
 * Cost parameters come from the stored hash rather than `HASH_OPTIONS`, so
 * hashes written before a cost change keep verifying.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    // A truncated or otherwise malformed hash is a failed login, not a 500.
    return false
  }
}
