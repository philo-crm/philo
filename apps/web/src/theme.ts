import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark' | 'system'

export const THEMES: readonly Theme[] = ['light', 'dark', 'system']

/** Per browser, like the selected funnel: a choice about this screen, not the instance. */
const THEME_KEY = 'philo.theme'

const listeners = new Set<() => void>()

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

export function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

/**
 * `system` is the absence of an override, so the stylesheet's
 * `prefers-color-scheme` rule decides — see index.css.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset['theme']
  else root.dataset['theme'] = theme
  // index.html gives the status bar one colour per system scheme; a theme
  // chosen here overrides both, or the bar would disagree with the page.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light'
    meta.content = TOPBAR_COLORS[theme === 'system' ? scheme : theme]
  }
}

/** The topbar's surface in each scheme — index.css `--surface`. */
const TOPBAR_COLORS = { light: '#ffffff', dark: '#1b2126' } as const

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Applied for this visit all the same.
  }
  applyTheme(theme)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme)
}
