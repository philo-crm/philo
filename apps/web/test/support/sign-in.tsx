import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import { App } from '../../src/App.tsx'
import { browser } from '../../src/auth.ts'
import { authorize, type FakeApi } from './fake-api.ts'

/**
 * Watches where the app sends the browser, since jsdom cannot go there.
 *
 * Cleared every time: `vi.spyOn` hands back the spy already on `assign` when a
 * test watches twice, calls and all, and a count carried over from the first
 * watch would let a test finish while its redirect is still in flight — which
 * then lands in the next test and overwrites that test's pending sign-in.
 */
export function watchRedirects() {
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined)
  assign.mockClear()
  return assign
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
