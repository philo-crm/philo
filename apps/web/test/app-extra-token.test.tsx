import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import { installFakeApi } from './support/fake-api.ts'
import { watchRedirects } from './support/sign-in.tsx'

const configureExtraTokens = vi.hoisted(() => vi.fn())
vi.mock('../src/extra-token.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/extra-token.ts')>()),
  configureExtraTokens,
}))

beforeEach(() => {
  configureExtraTokens.mockClear()
  window.history.pushState(null, '', '/')
})

describe('App and extra tokens', () => {
  it('hands the signed-in session to extra tokens, and takes it back on sign-out', async () => {
    installFakeApi({ leads: [] })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })
    expect(configureExtraTokens).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.anything() }))

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => expect(configureExtraTokens).toHaveBeenLastCalledWith(undefined))
  })

  it('drops extra tokens before revoking and going to the provider’s end-session page', async () => {
    const api = installFakeApi({ leads: [], endSessionEndpoint: 'https://idp.example.com/logout' })
    render(<App />)
    await screen.findByRole('heading', { name: 'Leads' })
    const assign = watchRedirects()
    let droppedBeforeLeaving = false
    assign.mockImplementation(() => {
      droppedBeforeLeaving = configureExtraTokens.mock.lastCall?.[0] === undefined
    })
    let droppedBeforeRevoking = false
    const revoked = api.revoked
    const push = revoked.push.bind(revoked)
    revoked.push = (...tokens: string[]) => {
      droppedBeforeRevoking = configureExtraTokens.mock.lastCall?.[0] === undefined
      return push(...tokens)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(assign).toHaveBeenCalledOnce())
    expect(revoked).toHaveLength(1)
    expect(droppedBeforeRevoking).toBe(true)
    expect(droppedBeforeLeaving).toBe(true)
  })

  it('never hands over a session before sign-in', async () => {
    installFakeApi({ signedIn: false })
    render(<App />)
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(configureExtraTokens).not.toHaveBeenCalledWith(expect.anything())
  })
})
