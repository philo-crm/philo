import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SILENT_CALLBACK_MESSAGE } from '../src/extra-token.ts'

const createRoot = vi.hoisted(() => vi.fn(() => ({ render: vi.fn() })))
const registerServiceWorker = vi.hoisted(() => vi.fn())
vi.mock('react-dom/client', () => ({ createRoot }))
vi.mock('../src/sw-register.ts', () => ({ registerServiceWorker }))

const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent')

beforeEach(() => {
  vi.resetModules()
  createRoot.mockClear()
  registerServiceWorker.mockClear()
  document.body.innerHTML = '<div id="root"></div>'
})

afterEach(() => {
  if (parentDescriptor !== undefined) Object.defineProperty(window, 'parent', parentDescriptor)
  window.history.pushState(null, '', '/')
})

describe('main', () => {
  it('in a hidden frame, hands the callback to the parent and never mounts the app', async () => {
    const postMessage = vi.fn()
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true })
    window.history.pushState(null, '', '/auth/callback?code=c&state=s')

    await import('../src/main.tsx')

    expect(postMessage).toHaveBeenCalledWith(
      { type: SILENT_CALLBACK_MESSAGE, url: `${window.location.origin}/auth/callback?code=c&state=s` },
      window.location.origin,
    )
    expect(createRoot).not.toHaveBeenCalled()
    expect(registerServiceWorker).not.toHaveBeenCalled()
  })

  it('mounts the app at the top level, callback or not', async () => {
    window.history.pushState(null, '', '/auth/callback?code=c&state=s')
    await import('../src/main.tsx')
    expect(createRoot).toHaveBeenCalledOnce()
  })
})
