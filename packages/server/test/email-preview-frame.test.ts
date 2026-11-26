import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { EMAIL_PREVIEW_FRAME_PATH } from '../src/email/preview-frame.ts'
import { cleanupTestApps, createTestApp, TEST_APP_URL } from './support/app.ts'

afterEach(cleanupTestApps)

function directives(policy: string | null): Map<string, string> {
  return new Map(
    (policy ?? '').split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/)
      return [name!, sources.join(' ')]
    }),
  )
}

/**
 * The email template preview. A `srcdoc` frame inherits its parent's CSP, and
 * the PWA's is `style-src 'self'; img-src 'self'`, which would strip a
 * template's styles and images. So the preview renders inside this page,
 * served with a policy of its own, and the PWA posts the rendered HTML in.
 */
describe(`GET ${EMAIL_PREVIEW_FRAME_PATH}`, () => {
  it('is public, holds no data, and may be cached only with revalidation', async () => {
    const res = await createTestApp().app.request(EMAIL_PREVIEW_FRAME_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('lets a template’s inline styles and remote images render', async () => {
    const res = await createTestApp().app.request(EMAIL_PREVIEW_FRAME_PATH)
    const policy = directives(res.headers.get('content-security-policy'))
    expect(policy.get('style-src')).toBe("'unsafe-inline'")
    expect(policy.get('img-src')).toBe('* data:')
  })

  it('runs only its own script, sandboxed, and can be framed only by the app', async () => {
    const res = await createTestApp().app.request(EMAIL_PREVIEW_FRAME_PATH)
    const html = await res.text()
    const policy = directives(res.headers.get('content-security-policy'))

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!)
    expect(scripts).toHaveLength(1)
    const hash = createHash('sha256').update(scripts[0]!).digest('base64')
    expect(policy.get('script-src')).toBe(`'sha256-${hash}'`)

    expect(policy.get('default-src')).toBe("'none'")
    // Opaque even if opened at the top level: it can reach no origin's storage.
    expect(policy.get('sandbox')).toBe('allow-scripts')
    expect(policy.get('frame-ancestors')).toBe(new URL(TEST_APP_URL).origin)
    expect(policy.get('form-action')).toBe("'none'")
    expect(policy.get('base-uri')).toBe("'none'")
  })

  it('takes HTML only from the app’s origin, and renders it with scripts off', async () => {
    const html = await (await createTestApp().app.request(EMAIL_PREVIEW_FRAME_PATH)).text()
    expect(html).toContain(`event.origin !== ${JSON.stringify(new URL(TEST_APP_URL).origin)}`)
    expect(html).toMatch(/<iframe[^>]*\bsandbox=""/)
  })

  it('names the app origin, not its path, as the frame ancestor', async () => {
    const res = await createTestApp({ appUrl: 'https://crm.example.com/app/' }).app.request(EMAIL_PREVIEW_FRAME_PATH)
    expect(directives(res.headers.get('content-security-policy')).get('frame-ancestors')).toBe(
      'https://crm.example.com',
    )
  })
})
