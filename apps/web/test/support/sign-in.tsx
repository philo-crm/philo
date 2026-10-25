import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import { App } from '../../src/App.tsx'
import { browser } from '../../src/auth.ts'
import { authorize, type FakeApi } from './fake-api.ts'

/** Watches where the app sends the browser, since jsdom cannot go there. */
export function watchRedirects() {
  return vi.spyOn(browser, 'assign').mockImplementation(() => undefined)
}

/** Renders a signed-out app, presses "Sign in", and answers with the authorize URL it redirected to. */
export async function startSignIn(): Promise<string> {
  const assign = watchRedirects()
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
  await waitFor(() => expect(assign).toHaveBeenCalledOnce())
  return String(assign.mock.calls[0]?.[0])
}

/** A fresh page load at `url`, as the IdP's redirect back is. */
export function reloadAt(url: string) {
  cleanup()
  window.history.replaceState(null, '', url)
  return render(<App />)
}

/** The whole round trip: sign in at the IdP and come back to the callback. */
export async function signInThroughIdp(api: FakeApi) {
  const authorizeUrl = await startSignIn()
  return reloadAt(authorize(api, authorizeUrl))
}
