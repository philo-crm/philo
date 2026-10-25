import { useCallback, useEffect, useState } from 'react'
import { isUnauthorized } from './http.ts'

export interface Resource<T> {
  data: T | undefined
  error: unknown
  /** True while a load is in flight. `data` keeps the previous value throughout. */
  loading: boolean
  reload: () => void
  /**
   * Replace the loaded value without a round trip. Every mutating lead endpoint
   * answers with the whole record, so a screen that just moved a stage already
   * holds the newest truth and refetching would only add a flicker.
   */
  set: (value: T) => void
}

interface State<T> {
  data?: T
  error?: unknown
  loading: boolean
}

/**
 * One fetch, cancelled on unmount and on every re-run. `load` must be stable —
 * wrap it in `useCallback` with the query it closes over, and changing that
 * query is what reloads.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<State<T>>({ loading: true })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    // Keep whatever is on screen and mark it stale, rather than blanking the
    // list on every keystroke of a search.
    setState((previous) => ({ ...previous, loading: true }))
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ data, loading: false })
      },
      (error: unknown) => {
        // An aborted request is a superseded one, not a failure to report.
        if (!controller.signal.aborted) setState({ error, loading: false })
      },
    )
    return () => controller.abort()
  }, [load, nonce])

  /**
   * Marks the load in flight here rather than leaving it to the effect below,
   * which does not run until after the commit. A caller that clears its own
   * "busy" flag in the same tick would otherwise get one painted frame with
   * every control enabled over the data the reload is about to replace.
   */
  const reload = useCallback(() => {
    setState((previous) => ({ ...previous, loading: true }))
    setNonce((value) => value + 1)
  }, [])
  const set = useCallback((value: T) => setState({ data: value, loading: false }), [])

  return { data: state.data, error: state.error, loading: state.loading, reload, set }
}

/**
 * A 401 anywhere behind the shell means the ~30-day session ended, and the only
 * useful answer is the login screen — an authenticated screen showing "your
 * session expired" next to stale data is a dead end a person cannot act on.
 */
export function useSessionGuard(error: unknown, onExpired: () => void): void {
  useEffect(() => {
    if (isUnauthorized(error)) onExpired()
  }, [error, onExpired])
}
