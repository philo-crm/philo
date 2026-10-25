import { createPhiloClient } from '@philo/sdk'

/** The PWA's one connection to the API. Same origin unless built otherwise. */
export const philo = createPhiloClient({ baseUrl: import.meta.env.VITE_PHILO_API_URL })
