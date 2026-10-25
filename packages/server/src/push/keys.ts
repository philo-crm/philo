import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush from 'web-push'

/** Lives in PHILO_DATA_DIR alongside the database, so a backup carries it. */
export const VAPID_KEYS_FILENAME = 'vapid-keys.json'

/** URL-safe base64, as `generateVAPIDKeys` returns them and as the browser wants them. */
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

export interface VapidKeysResult {
  keys: VapidKeys
  /**
   * Whether this call minted the pair. A subscription is bound to the key it was
   * created with, so every stored row is undeliverable once this is true — the
   * caller is expected to clear them rather than push at endpoints that can only
   * answer 403 from here on.
   */
  generated: boolean
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Undefined for a file that is missing, empty, or not a usable pair. A partial
 * file is treated as no file for the same reason the session key is: a process
 * killed mid-write leaves one, and a keypair that cannot be used is not made
 * more usable by refusing to boot behind it.
 */
function readKeys(path: string): VapidKeys | undefined {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { publicKey, privateKey } = parsed as Record<string, unknown>
  if (!isKey(publicKey) || !isKey(privateKey)) return undefined
  return { publicKey, privateKey }
}

/**
 * The VAPID pair that signs every push. ADR-0004: keys auto-generate at first
 * boot into the data dir, so a self-hoster sets nothing up to get push.
 *
 * Losing the file costs everyone their subscription — the browser has to be
 * asked again — but never a lead, because email is the guaranteed channel.
 */
export function loadOrCreateVapidKeys(dataDir: string): VapidKeysResult {
  const path = join(dataDir, VAPID_KEYS_FILENAME)
  const existing = readKeys(path)
  if (existing !== undefined) return { keys: existing, generated: false }

  const keys = webpush.generateVAPIDKeys()
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // `mode` above only applies when the write creates the file; a truncated file
  // left over from a crash gets its permissions fixed here.
  chmodSync(path, 0o600)
  return { keys, generated: true }
}

/**
 * The `sub` claim in the VAPID JWT: contact information for whoever runs this
 * deployment, which a push service may use to get in touch about it. RFC 8292
 * allows any URI; `web-push` narrows that to https or mailto.
 *
 * The deployment's own URL is preferred because it identifies the instance
 * without handing a push service an operator's personal address. That leaves
 * localhost dev, where the URL is http and would be refused — the operator's
 * address is the only other contact the instance knows, and a browser will not
 * subscribe over plain http anywhere else, so this is the whole of the gap.
 */
export function vapidSubject(publicBaseUrl: string, operatorEmail: string | undefined): string | undefined {
  if (publicBaseUrl.startsWith('https://')) return publicBaseUrl
  if (operatorEmail === undefined || operatorEmail === '') return undefined
  return `mailto:${operatorEmail}`
}
