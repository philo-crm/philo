import { createPhiloClient, type AccessTokenSource } from '@philo/sdk'

let tokenSource: AccessTokenSource | undefined

/**
 * Where the client's bearer token comes from. Set once sign-in has a session
 * (auth.ts), cleared on sign-out; until then requests go out without one,
 * which is all `auth.config` needs.
 */
export function setAccessTokenSource(source: AccessTokenSource | undefined): void {
  tokenSource = source
}

/** The PWA's one connection to the API. Same origin unless built otherwise. */
export const philo = createPhiloClient({
  baseUrl: import.meta.env.VITE_PHILO_API_URL,
  accessToken: () => tokenSource?.(),
})
