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
    const frame = within(ack).getByTitle('Applicant acknowledgment preview')
    expect(frame.getAttribute('srcdoc')).toBe('<p>Hi Sample Applicant</p>')
    // Sandboxed with no capabilities: operator HTML must not run against this origin.
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(within(ack).getByText('Rendered against a sample lead.')).toBeDefined()
    expect(api.emailTemplates.find((row) => row.trigger === 'new_lead_ack')?.subject).toBe(
      'Thanks for getting in touch',
    )
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
