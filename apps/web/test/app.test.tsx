import { pkceChallenge } from '@philo/sdk'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { REFRESH_TOKEN_KEY } from '../src/auth.ts'
import { authorize, installFakeApi, makeLead, TEST_CLIENT_ID, TEST_ISSUER } from './support/fake-api.ts'
import { reloadAt, signInThroughIdp, startSignIn, watchRedirects } from './support/sign-in.tsx'

beforeEach(() => {
  // Each test starts at the funnel; the router reads window.location directly.
  window.history.pushState(null, '', '/')
})

describe('App', () => {
  it('sends a signed-out browser to the IdP with a PKCE authorization request', async () => {
    installFakeApi({ signedIn: false })
    const url = new URL(await startSignIn())

    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_ISSUER}/oauth/authorize`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(TEST_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/auth/callback`)
    expect(url.searchParams.get('scope')).toBe('openid operator')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('state')).not.toBe('')
    expect(url.searchParams.get('nonce')).not.toBe('')
  })

  it('exchanges the code on the way back and lands signed in', async () => {
    const api = installFakeApi({ signedIn: false, leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    const authorizeUrl = await startSignIn()
    reloadAt(authorize(api, authorizeUrl))

    expect(await screen.findByRole('heading', { name: 'Leads' })).toBeDefined()
    expect(await screen.findByText('Dana Okafor')).toBeDefined()
    // The code is single-use, so it must not survive in the address bar.
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')

    const exchange = api.calls.find((call) => call.path === '/oauth/token')?.body as URLSearchParams
    expect(exchange.get('grant_type')).toBe('authorization_code')
    const challenge = new URL(authorizeUrl).searchParams.get('code_challenge')
    expect(await pkceChallenge(exchange.get('code_verifier') ?? '')).toBe(challenge)
    // Every API call after that carries the token, and nothing else.
    const leads = api.calls.find((call) => call.path === '/api/v1/leads')
    expect(leads?.authorization).toBe(`Bearer ${api.accessToken}`)
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBe(api.refreshToken)
  })

  it('comes back to the page that needed the sign-in', async () => {
    window.history.pushState(null, '', '/spam')
    const api = installFakeApi({ signedIn: false })
    await signInThroughIdp(api)

    expect(await screen.findByRole('heading', { name: 'Spam' })).toBeDefined()
    expect(window.location.pathname).toBe('/spam')
  })

  it('refuses a callback whose state this browser did not send, and offers to start again', async () => {
    const api = installFakeApi({ signedIn: false })
    const callback = new URL(authorize(api, await startSignIn()))
    callback.searchParams.set('state', 'forged')
    reloadAt(callback.toString())

    expect(await screen.findByRole('heading', { name: 'Sign-in failed' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toMatch(/does not match/)
    expect(api.calls.some((call) => call.path === '/oauth/token')).toBe(false)
    expect(window.location.pathname).toBe('/')

    const assign = watchRedirects()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
  })

  it('says so when the person cancelled at the IdP', async () => {
    installFakeApi({ signedIn: false })
    const state = new URL(await startSignIn()).searchParams.get('state') ?? ''
    reloadAt(`/auth/callback?error=access_denied&state=${state}`)

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sign-in was cancelled.')
  })

  it('treats a refresh token the IdP no longer honours as signed out', async () => {
    const api = installFakeApi()
    api.refreshToken = 'revoked-elsewhere'
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull()
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

  it('reaches server settings from the account menu, and stops lighting Leads', async () => {
    installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('link', { name: 'Server settings' }))

    expect(await screen.findByRole('heading', { name: 'Server settings' })).toBeDefined()
    expect(window.location.pathname).toBe('/settings')
    expect(await screen.findByLabelText('SMTP host')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Leads' }).getAttribute('aria-current')).toBeNull()
    // The menu shuts once it has taken you somewhere.
    expect(screen.queryByRole('link', { name: 'Server settings' })).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'API keys' }))
    expect(window.location.pathname).toBe('/settings/api-keys')
    expect(await screen.findByRole('heading', { name: 'API keys' })).toBeDefined()
  })

  it('reaches the selected funnel’s settings from the switcher', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(await screen.findByRole('button', { name: 'Funnel: Default' }))
    fireEvent.click(screen.getByRole('link', { name: 'Funnel settings' }))

    expect(await screen.findByRole('heading', { name: 'Default funnel' })).toBeDefined()
    fireEvent.click(screen.getByRole('link', { name: 'Website form' }))
    expect(window.location.pathname).toBe('/funnel/form')
    expect(await screen.findByText('Sample form')).toBeDefined()
  })

  it('switches the colour theme from the account menu', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'System' }))
    expect(document.documentElement.dataset['theme']).toBeUndefined()
  })

  it('opens a blank new lead from the top bar', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('link', { name: 'New lead' }))

    expect(await screen.findByRole('heading', { name: 'New lead' })).toBeDefined()
    expect(window.location.pathname).toBe('/leads/new')
  })

  it('reaches the funnel board from the shell', async () => {
    installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })

    fireEvent.click(screen.getByRole('link', { name: 'Board' }))

    expect(await screen.findByRole('heading', { name: 'Default' })).toBeDefined()
    expect(window.location.pathname).toBe('/board')
    // A card on the board opens the same lead screen the list does.
    fireEvent.click(await screen.findByRole('link', { name: 'Dana Okafor' }))
    expect(await screen.findByRole('heading', { name: 'Dana Okafor' })).toBeDefined()
  })

  it('returns to the signed-out screen when the session expires mid-session', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 1, name: 'Dana Okafor' })] })
    render(<App />)
    await screen.findByText('Dana Okafor')

    api.expired = true
    fireEvent.click(screen.getByRole('link', { name: 'Spam' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
    // A refused token is not kept around to be refused again on the next load.
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull()
  })

  it('signs out by revoking the grant at the IdP', async () => {
    const api = installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })
    const refreshToken = api.refreshToken

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
    expect(api.revoked).toEqual([refreshToken])
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull()
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
