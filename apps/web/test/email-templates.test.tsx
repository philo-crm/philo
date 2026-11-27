import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EmailTemplates } from '../src/EmailTemplates.tsx'
import { installFakeApi, makeLead, TEST_USER, type FakeApi } from './support/fake-api.ts'

function renderTemplates(onSessionExpired = vi.fn()) {
  return render(<EmailTemplates onSessionExpired={onSessionExpired} />)
}

/** The acknowledgment's editor, once it is on screen. */
async function ackEditor(): Promise<HTMLElement> {
  return screen.findByRole('form', { name: 'Applicant acknowledgment' })
}

function click(form: HTMLElement, name: string) {
  fireEvent.click(within(form).getByRole('button', { name }))
}

function type(form: HTMLElement, label: string, value: string) {
  fireEvent.change(within(form).getByLabelText(label), { target: { value } })
}

describe('EmailTemplates', () => {
  it('shows both templates with their stored source', async () => {
    installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    expect((within(ack).getByLabelText('Subject') as HTMLInputElement).value).toBe(
      'Thanks for getting in touch',
    )
    const notify = screen.getByRole('form', { name: 'New lead notification' })
    expect((within(notify).getByLabelText('Subject') as HTMLInputElement).value).toBe(
      'New lead: {{lead.name}}',
    )
    expect((within(notify).getByLabelText('Body (HTML)') as HTMLTextAreaElement).value).toContain(
      '{{lead_url}}',
    )
  })

  it('saves an edited subject and body', async () => {
    const api = installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    type(ack, 'Subject', 'Welcome, {{lead.name}}')
    type(ack, 'Body (HTML)', '<p>Hello {{lead.name}}</p>')
    click(ack, 'Save template')

    expect(await within(ack).findByText('Template saved.')).toBeDefined()
    const stored = api.emailTemplates.find((template) => template.trigger === 'new_lead_ack')
    expect(stored?.subject).toBe('Welcome, {{lead.name}}')
    expect(stored?.body).toBe('<p>Hello {{lead.name}}</p>')
  })

  it('saves the enabled switch', async () => {
    const api = installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    fireEvent.click(within(ack).getByLabelText('Send this email'))
    click(ack, 'Save template')

    await within(ack).findByText('Template saved.')
    expect(api.emailTemplates.find((row) => row.trigger === 'new_lead_ack')?.enabled).toBe(false)
    // The other one is untouched: each editor saves only itself.
    expect(api.emailTemplates.find((row) => row.trigger === 'new_lead_notify')?.enabled).toBe(true)
  })

  it('reports invalid Handlebars instead of saving it', async () => {
    const api = installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    type(ack, 'Body (HTML)', '<p>{{#if lead.name}}Hi</p>')
    click(ack, 'Save template')

    expect(
      await within(ack).findByText('The body is not valid Handlebars, so nothing was saved. Parse error.'),
    ).toBeDefined()
    expect(api.emailTemplates.find((row) => row.trigger === 'new_lead_ack')?.body).toContain(
      '{{business.name}}',
    )
  })

  it('previews the boxes as they stand, without saving them', async () => {
    const api = installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    type(ack, 'Subject', 'Draft for {{lead.name}}')
    type(ack, 'Body (HTML)', '<p>Hi {{lead.name}}</p>')
    click(ack, 'Preview')

    expect(await within(ack).findByText('Draft for Sample Applicant')).toBeDefined()
    const frame = within(ack).getByTitle('Applicant acknowledgment preview') as HTMLIFrameElement
    expect(await renderedInto(frame)).toBe('<p>Hi Sample Applicant</p>')
    expect(within(ack).getByText('Rendered against a sample lead.')).toBeDefined()
    expect(api.emailTemplates.find((row) => row.trigger === 'new_lead_ack')?.subject).toBe(
      'Thanks for getting in touch',
    )
  })

  it('previews in the server’s frame page, which keeps a template’s styles and images', async () => {
    // A srcdoc frame would inherit the PWA's CSP (style-src 'self'; img-src
    // 'self') and drop all three. The frame page has a policy of its own.
    installFakeApi()
    renderTemplates()
    const ack = await ackEditor()
    const styled =
      '<style>p { color: #c00 }</style><p style="font-weight: bold">Hi</p><img src="https://img.example.com/logo.png">'

    type(ack, 'Body (HTML)', styled)
    click(ack, 'Preview')

    const frame = (await within(ack).findByTitle('Applicant acknowledgment preview')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('/api/email-preview')
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    // Its own script runs, in an opaque origin; the template's never does
    // (the page renders it in a sandbox="" frame of its own).
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await renderedInto(frame)).toBe(styled)
  })

  it('sends the preview only to its own frame, and only once that frame asks', async () => {
    installFakeApi()
    renderTemplates()
    const ack = await ackEditor()
    click(ack, 'Preview')
    const frame = (await within(ack).findByTitle('Applicant acknowledgment preview')) as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')

    // Nothing is sent before the frame asks; once it does, exactly once.
    expect(post).not.toHaveBeenCalled()
    await announceReady(frame, post)
    expect(post).toHaveBeenCalledTimes(1)

    // Another window announcing itself gets nothing — checked once the preview
    // is surely listening, so the silence means something.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'philo:email-preview-ready' }, source: window }))
    expect(post).toHaveBeenCalledTimes(1)

    // A new preview reaches the frame on screen, whichever it is.
    type(ack, 'Body (HTML)', '<p>Again</p>')
    click(ack, 'Preview')
    await within(ack).findByText('Rendered against a sample lead.')
    const current = within(ack).getByTitle('Applicant acknowledgment preview') as HTMLIFrameElement
    await waitFor(async () => expect(await renderedInto(current)).toBe('<p>Again</p>'))
  })

  it('previews against a real lead when one is named', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 42 })] })
    renderTemplates()
    const ack = await ackEditor()

    type(ack, 'Preview against lead', '42')
    click(ack, 'Preview')

    expect(await within(ack).findByText('Rendered against lead #42.')).toBeDefined()
    expect(lastPreviewBody(api)).toMatchObject({ leadId: 42 })
  })

  it('says so when the named lead is gone', async () => {
    installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    type(ack, 'Preview against lead', '999')
    click(ack, 'Preview')

    expect(
      await within(ack).findByText(
        'That lead no longer exists, so there was nothing to preview against.',
      ),
    ).toBeDefined()
  })

  it('test-sends the draft to the signed-in operator', async () => {
    const api = installFakeApi()
    renderTemplates()
    const ack = await ackEditor()

    type(ack, 'Body (HTML)', '<p>Draft body</p>')
    click(ack, 'Send test to me')

    expect(await within(ack).findByText(`Test email sent to ${TEST_USER.email}.`)).toBeDefined()
    expect(api.templateEmailsSent).toEqual([
      { trigger: 'new_lead_ack', subject: 'Thanks for getting in touch', body: '<p>Draft body</p>' },
    ])
    // A rehearsal, never a save.
    expect(api.emailTemplates.find((row) => row.trigger === 'new_lead_ack')?.body).toContain(
      '{{business.name}}',
    )
  })

  it('passes the mail server’s complaint through', async () => {
    installFakeApi({ testEmailFailure: '535 authentication failed' })
    renderTemplates()
    const ack = await ackEditor()

    click(ack, 'Send test to me')

    expect(
      await within(ack).findByText('The mail server refused the message. 535 authentication failed'),
    ).toBeDefined()
  })

  it('hands an expired session back to the shell', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ expired: true })
    renderTemplates(onSessionExpired)

    await waitFor(() => {
      expect(onSessionExpired).toHaveBeenCalled()
    })
  })
})

function lastPreviewBody(api: FakeApi): Record<string, unknown> {
  const call = api.calls.findLast((entry) => entry.path.endsWith('/preview'))
  return (call?.body ?? {}) as Record<string, unknown>
}

/**
 * What the preview frame is handed once its page says it is ready — the page
 * itself is the server's (packages/server/src/email/preview-frame.ts).
 */
async function renderedInto(frame: HTMLIFrameElement): Promise<string> {
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  await announceReady(frame, post)
  const [message, target] = post.mock.lastCall!
  // The page is an opaque origin (sandboxed), which only '*' can address.
  expect(target).toBe('*')
  expect(message).toMatchObject({ type: 'philo:email-preview' })
  return (message as { html: string }).html
}

/**
 * The frame's page saying it is ready, until the preview answers. The preview
 * listens from a passive effect, which can run a moment after the frame is on
 * screen, and an announcement before then is lost — as a real page's would be.
 */
async function announceReady(frame: HTMLIFrameElement, post: { mock: { calls: unknown[] } }): Promise<void> {
  await waitFor(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'philo:email-preview-ready' }, source: frame.contentWindow }),
    )
    expect(post.mock.calls.length).toBeGreaterThan(0)
  })
}
