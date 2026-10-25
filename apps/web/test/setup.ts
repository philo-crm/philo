import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest runs without globals, so React Testing Library's own auto-cleanup hook
// never registers; unmounting between tests has to be asked for explicitly.
afterEach(cleanup)

/**
 * Newer Node defines its own `localStorage` global, which is undefined without
 * `--localstorage-file` and shadows jsdom's. The refresh token lives there, so
 * the tests need one that works; a Map is all a test ever asks of it.
 */
if (globalThis.localStorage === undefined) {
  const items = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return items.size
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}
