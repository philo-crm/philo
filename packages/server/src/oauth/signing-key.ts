import { createHash, createPrivateKey, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Lives in PHILO_DATA_DIR alongside the database, so a backup carries it. */
export const SIGNING_KEY_FILENAME = 'oidc-signing-key.json'

export const ID_TOKEN_ALG = 'ES256'

/**
 * The key the built-in IdP signs id_tokens with. Only id_tokens: access
 * tokens stay opaque and database-backed (ADR-0006), so nothing that grants
 * access ever depends on this key.
 */
export interface SigningKey {
  /** RFC 7638 thumbprint, so a rotated key is told apart from its predecessor. */
  kid: string
  privateKey: KeyObject
  /** What `/oauth/jwks` publishes. */
  publicJwk: PublicJwk
}

export interface PublicJwk {
  kty: string
  crv: string
  x: string
  y: string
  kid: string
  alg: string
  use: string
}

function thumbprint(jwk: JsonWebKey): string {
  // RFC 7638 §3.2: the required members, lexicographic order, no whitespace.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return createHash('sha256').update(canonical).digest('base64url')
}

function toSigningKey(privateJwk: JsonWebKey): SigningKey {
  const privateKey = createPrivateKey({ key: privateJwk, format: 'jwk' })
  const { crv, kty, x, y } = privateJwk
  if (crv === undefined || kty === undefined || x === undefined || y === undefined) {
    throw new Error('signing key is missing a public component')
  }
  const kid = thumbprint(privateJwk)
  return { kid, privateKey, publicJwk: { crv, kty, x, y, kid, alg: ID_TOKEN_ALG, use: 'sig' } }
}

/**
 * Undefined for a file that is missing, empty, or not a usable key — a process
 * killed mid-write leaves a partial one, and refusing to boot behind it would
 * fix nothing. Same reasoning as the VAPID keys and the session key.
 */
function readKey(path: string): SigningKey | undefined {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const jwk = JSON.parse(contents) as JsonWebKey
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') return undefined
    return toSigningKey(jwk)
  } catch {
    return undefined
  }
}

/**
 * Generated at first boot, like every other secret Philo can make for itself.
 * Losing it invalidates outstanding id_tokens only — which a client checks
 * once, at sign-in — so a lost key costs nobody their access.
 */
export function loadOrCreateSigningKey(dataDir: string): SigningKey {
  const path = join(dataDir, SIGNING_KEY_FILENAME)
  const existing = readKey(path)
  if (existing !== undefined) return existing

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  writeFileSync(path, `${JSON.stringify(jwk, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // `mode` only applies when the write creates the file.
  chmodSync(path, 0o600)
  return toSigningKey(jwk)
}
