import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LeadDetail } from '../src/LeadDetail.tsx'
import { installFakeApi, makeLead, TEST_USER } from './support/fake-api.ts'

function applicant() {
  return makeLead({
    id: 5,
    name: 'Dana Okafor',
    phone: '555-0100',
    fields: { years_experience: 6, endorsements: ['hazmat', 'tanker'], owns_truck: false },
  })
}

function renderDetail(id = 5) {
  return render(<LeadDetail leadId={id} currentUserId={TEST_USER.id} onSessionExpired={vi.fn()} />)
}

describe('LeadDetail', () => {
  it('renders the core fields and the submitted answers as labeled pairs', async () => {
    installFakeApi({ leads: [applicant()] })
    renderDetail()

    expect(await screen.findByRole('heading', { name: 'Dana Okafor' })).toBeDefined()
    expect(screen.getByRole('link', { name: 'lead5@example.com' }).getAttribute('href')).toBe(
      'mailto:lead5@example.com',
    )
    expect(screen.getByRole('link', { name: '555-0100' }).getAttribute('href')).toBe('tel:555-0100')

    expect(screen.getByText('Years experience')).toBeDefined()
    expect(screen.getByText('6')).toBeDefined()
    expect(screen.getByText('hazmat, tanker')).toBeDefined()
    expect(screen.getByText('Owns truck')).toBeDefined()
    expect(screen.getByText('No')).toBeDefined()
  })

  it('shows the timeline without leaking the intake form key', async () => {
    installFakeApi({ leads: [applicant()] })
    renderDetail()

    expect(await screen.findByText('Lead created')).toBeDefined()
    expect(screen.getByText('Intake form')).toBeDefined()
    expect(document.body.textContent).not.toContain('sekrit-form-key')
  })

  it('adds a note, clears the box, and puts it at the top of the timeline', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    const box = screen.getByLabelText('Add a note')
    fireEvent.change(box, { target: { value: 'Left a voicemail.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    expect(await screen.findByText('Left a voicemail.')).toBeDefined()
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''))

    const entries = screen.getAllByRole('listitem')
    expect(entries[0]?.textContent).toContain('Left a voicemail.')
    expect(entries[0]?.textContent).toContain('You')
    expect(api.leads[0]?.events.at(-1)?.type).toBe('note_added')
  })

  it('refuses to send an empty note', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Add note' }).hasAttribute('disabled')).toBe(true)
    expect(api.calls.some((call) => call.path.endsWith('/notes'))).toBe(false)
  })

  it('moves the lead to another stage and records it on the timeline', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } })

    expect(await screen.findByText('Stage changed')).toBeDefined()
    expect(screen.getByText('New → Contacted')).toBeDefined()
    expect(api.leads[0]?.stageName).toBe('Contacted')
  })

  it('promotes a quarantined lead and drops the spam banner', async () => {
    const api = installFakeApi({ leads: [makeLead({ id: 5, name: 'Bot', isSpam: true })] })
    renderDetail()

    fireEvent.click(await screen.findByRole('button', { name: 'Not spam' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Not spam' })).toBeNull())
    expect(api.leads[0]?.isSpam).toBe(false)
    expect(screen.getByText('System note')).toBeDefined()
  })

  it('still hands back to login when a 401 arrives behind an unrelated failure', async () => {
    const onSessionExpired = vi.fn()
    const api = installFakeApi({ leads: [applicant()], offline: /\/stages$/ })
    render(
      <LeadDetail leadId={5} currentUserId={TEST_USER.id} onSessionExpired={onSessionExpired} />,
    )
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    // The funnel request already failed for an ordinary reason; the session
    // ending afterwards must still win, or the reader is stranded here.
    api.expired = true
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'Called back.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled())
  })

  it('says so when the funnel fails to load, rather than a select that cannot move', async () => {
    installFakeApi({ leads: [applicant()], offline: /\/stages$/ })
    renderDetail()

    expect(await screen.findByRole('alert')).toBeDefined()
    // The lead itself loaded; it is stage movement that is unavailable.
    expect(screen.getByRole('heading', { name: 'Dana Okafor' })).toBeDefined()
  })

  it('says so when the lead is gone rather than showing an empty record', async () => {
    installFakeApi({ leads: [] })
    renderDetail(404)

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('That lead no longer exists.')).toBeDefined()
  })

  it('adds a detail, shows it, and removes it again', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' start_date ' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Nov 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save detail' }))

    expect(await screen.findByText('Nov 2')).toBeDefined()
    expect(api.calls.at(-1)?.body).toEqual({ details: { start_date: 'Nov 2' } })
    expect(screen.getByText('Details updated')).toBeDefined()
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''))

    fireEvent.click(screen.getByRole('button', { name: 'Remove Start date' }))
    await waitFor(() => expect(screen.queryByText('Nov 2')).toBeNull())
    expect(api.leads[0]?.details).toEqual({})
  })

  it('uploads a file, lists it, and removes it after asking', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    const file = new File(['%PDF'], 'resume.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Attach a file'), { target: { files: [file] } })

    expect(await screen.findByRole('button', { name: 'resume.pdf' })).toBeDefined()
    const upload = api.calls.find((call) => call.method === 'POST' && call.path.endsWith('/attachments'))
    expect(upload?.query.get('filename')).toBe('resume.pdf')
    expect(upload?.contentType).toBe('application/pdf')

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove resume.pdf' }))
    expect(api.leads[0]?.attachments).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove resume.pdf' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'resume.pdf' })).toBeNull())
    expect(api.leads[0]?.attachments).toEqual([])
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('refuses a file over the limit without sending it', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })

    const file = new File(['x'], 'huge.mov')
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })
    fireEvent.change(screen.getByLabelText('Attach a file'), { target: { files: [file] } })

    expect((await screen.findByRole('alert')).textContent).toBeDefined()
    expect(api.calls.some((call) => call.path.endsWith('/attachments'))).toBe(false)
  })

  it('downloads a file through the API, under its own name', async () => {
    const api = installFakeApi({ leads: [applicant()] })
    renderDetail()
    await screen.findByRole('heading', { name: 'Dana Okafor' })
    fireEvent.change(screen.getByLabelText('Attach a file'), {
      target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    })
    const link = await screen.findByRole('button', { name: 'notes.txt' })

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake')
    // A subclass, so unstubGlobals puts the real URL back untouched.
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = createObjectURL
        static override revokeObjectURL = vi.fn()
      },
    )
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(link)

    await waitFor(() => expect(click).toHaveBeenCalled())
    const anchor = click.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.download).toBe('notes.txt')
    await expect(createObjectURL.mock.calls[0]![0].text()).resolves.toBe('hello')
    expect(api.calls.at(-1)?.authorization).toMatch(/^Bearer /)
  })

  it('names a removed detail and an attached file on the timeline', async () => {
    installFakeApi({
      leads: [
        makeLead({
          id: 5,
          events: [
            { id: 1, type: 'details_changed', payload: { keys: ['start_date'] }, actor: 'user:1', createdAt: '2026-07-01T12:00:00.000Z' },
            { id: 2, type: 'attachment_added', payload: { filename: 'offer.pdf' }, actor: 'user:1', createdAt: '2026-07-01T12:00:00.000Z' },
          ],
        }),
      ],
    })
    renderDetail()

    expect(await screen.findByText('Details updated')).toBeDefined()
    expect(screen.getByText('Start date')).toBeDefined()
    expect(screen.getByText('File attached')).toBeDefined()
    expect(screen.getByText('offer.pdf')).toBeDefined()
  })
})
