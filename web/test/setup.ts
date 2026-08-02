import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest runs without globals, so React Testing Library's own auto-cleanup hook
// never registers; unmounting between tests has to be asked for explicitly.
afterEach(cleanup)
