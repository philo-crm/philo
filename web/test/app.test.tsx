import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { installFakeApi, makeLead } from './support/fake-api.ts'

beforeEach(() => {
  // Each test starts at the funnel; the router reads window.location directly.
  window.history.pushState(null, '', '/')
})

describe('App', () => {
  it('signs in and lands on the lead list', async () => {
    installFakeApi({ user: undefined, leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'owner@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Leads' })).toBeDefined()
    expect(await screen.findByText('Dana Okafor')).toBeDefined()
  })

  it('opens a lead from the list and comes back', async () => {
    installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: 'Dana Okafor' }))

    expect(await screen.findByRole('heading', { name: 'Dana Okafor' })).toBeDefined()
    expect(window.location.pathname).toBe('/leads/1')

    fireEvent.click(screen.getByRole('link', { name: '← Leads' }))
    expect(await screen.findByRole('heading', { name: 'Leads' })).toBeDefined()
  })

  it('serves a deep link straight into a lead', async () => {
    window.history.pushState(null, '', '/leads/1')
    installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Dana Okafor' })).toBeDefined()
  })

  it('reaches the spam view from the shell', async () => {
    installFakeApi({ leads: [makeLead({ id: 2, name: 'Bot Submission', isSpam: true })] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('link', { name: 'Spam' }))

    expect(await screen.findByRole('heading', { name: 'Spam' })).toBeDefined()
    expect(await screen.findByText('Bot Submission')).toBeDefined()
  })

  it('returns to the login screen when the session expires mid-session', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)
    await screen.findByText('Dana Okafor')

    api.expired = true
    fireEvent.click(screen.getByRole('link', { name: 'Spam' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
  })

  it('signs out', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
  })

  it('shows a not-found screen for an unknown path', async () => {
    window.history.pushState(null, '', '/nope')
    installFakeApi({ leads: [] })
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeDefined()
  })

  it('offers a retry when the server cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    render(<App />)

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
  })
})
