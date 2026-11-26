import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { FunnelBoard } from '../src/FunnelBoard.tsx'
import { Settings } from '../src/Settings.tsx'
import { installFakeApi, makeLead, TEST_USER } from './support/fake-api.ts'

/** ADR-0012: a user works leads; configuration is an admin's, and a user's screens leave it out. */
const USER = { ...TEST_USER, role: 'user' as const }

beforeEach(() => {
  window.history.pushState(null, '', '/')
})

describe('a user-role session', () => {
  it('offers its own settings, not the server’s, from the account menu', async () => {
    installFakeApi({ user: USER, leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(screen.queryByRole('link', { name: 'Server settings' })).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined()
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Notifications', 'API keys'])
  })

  it('leaves funnel configuration out of the switcher', async () => {
    installFakeApi({ user: USER, leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(await screen.findByRole('button', { name: 'Funnel: Default' }))
    expect(screen.queryByRole('link', { name: 'Funnel settings' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Add or remove funnels' })).toBeNull()
  })

  it('answers a deep link to an admin screen with who to ask, and never loads it', async () => {
    const api = installFakeApi({ user: USER, leads: [] })
    window.history.pushState(null, '', '/settings/webhooks')
    render(<App />)
    expect(await screen.findByText(/Only an admin can change this/)).toBeDefined()

    window.history.pushState(null, '', '/funnel')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(await screen.findByText(/Only an admin can change this/)).toBeDefined()
    expect(api.calls.some((call) => call.path.includes('/webhooks') || call.path.includes('/settings/'))).toBe(false)
  })

  it('opens a user straight on notifications at /settings', () => {
    installFakeApi({ user: USER })
    render(<Settings isAdmin={false} onSessionExpired={vi.fn()} />)
    expect(screen.getByRole('link', { name: 'Notifications' }).getAttribute('aria-current')).toBe('page')
  })
})

describe('the board for a user', () => {
  it('keeps the leads and drops the stage editing', async () => {
    installFakeApi({ user: USER, leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<FunnelBoard canConfigure={false} onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    expect(screen.queryByRole('button', { name: 'New stage' })).toBeNull()
    expect(screen.queryByRole('button', { name: /options$/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Funnel settings' })).toBeNull()
    expect(document.querySelector('.column-grip')).toBeNull()
    // Adding a lead to a stage is working leads, so it stays.
    expect(screen.getAllByRole('button', { name: /^Add a lead to / }).length).toBeGreaterThan(0)
  })
})
