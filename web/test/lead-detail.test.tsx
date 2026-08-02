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

    const box = screen.getByRole('textbox')
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

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
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

  it('says so when the lead is gone rather than showing an empty record', async () => {
    installFakeApi({ leads: [] })
    renderDetail(404)

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText('That lead no longer exists.')).toBeDefined()
  })
})
