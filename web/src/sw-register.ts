/**
 * Registers /sw.js — the offline shell and the push renderer (src/sw.js).
 *
 * Build only: in dev there is no built shell to cache, and a worker holding on
 * to a dev response is a debugging trap rather than a feature.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return
  // Nothing on screen depends on this, and it fails on any page served over
  // plain http from a non-localhost host — a self-hoster mid-setup.
  navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
