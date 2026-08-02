import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

/**
 * Three screens do not need a routing library. History API plus one subscriber
 * set is the whole thing, and the server already answers an unknown path with
 * the app shell (server/src/app.ts), so a deep link survives a cold load.
 */
const listeners = new Set<() => void>()

function currentPath(): string {
  return window.location.pathname
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Back/forward do not go through navigate(), so popstate has to be heard too.
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

export function navigate(to: string): void {
  if (to === currentPath()) return
  window.history.pushState(null, '', to)
  for (const listener of listeners) listener()
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath)
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }

/**
 * A real anchor, not a button dressed as one: middle-click, cmd-click, "open in
 * new tab" and "copy link address" all keep working, and only a plain left
 * click is intercepted.
 */
export function Link({ to, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(to)
  }

  return <a {...rest} href={to} onClick={handleClick} />
}
