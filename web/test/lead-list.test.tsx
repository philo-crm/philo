import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LeadList } from '../src/LeadList.tsx'
import { installFakeApi, makeLead } from './support/fake-api.ts'

function leads() {
  return [
    makeLead({ id: 1, name: 'Dana Okafor', phone: '555-0100', fields: { endorsements: 'hazmat' } }),
    makeLead({ id: 2, name: 'Sam Reyes', stageId: 2, stageName: 'Contacted' }),
  ]
}

describe('LeadList', () => {
  it('lists leads with their contact details and stage', async () => {
    installFakeApi({ leads: leads() })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)

    expect(await screen.findByText('Dana Okafor')).toBeDefined()
    expect(screen.getByText('lead1@example.com · 555-0100')).toBeDefined()
    // Scoped to the table: the stage filter lists every stage name too.
    expect(within(screen.getByRole('table')).getByText('Contacted')).toBeDefined()
    expect(screen.getByText('2 leads')).toBeDefined()
  })

  it('searches the API rather than filtering what it already has', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    await screen.findByText('Sam Reyes')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'hazmat' } })

    await waitForElementToBeRemoved(() => screen.queryByText('Sam Reyes'))
    expect(screen.getByText('Dana Okafor')).toBeDefined()
    const searched = api.calls.filter((call) => call.query.get('search') === 'hazmat')
    expect(searched.length).toBeGreaterThan(0)
    expect(searched[0]?.query.get('spam')).toBe('false')
  })

  it('filters by stage', async () => {
    const api = installFakeApi({ leads: leads() })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)
    await screen.findByText('Dana Okafor')

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: '2' } })

    await waitForElementToBeRemoved(() => screen.queryByText('Dana Okafor'))
    expect(screen.getByText('Sam Reyes')).toBeDefined()
    expect(api.calls.some((call) => call.query.get('stage') === '2')).toBe(true)
  })

  it('promotes a quarantined lead out of the spam view', async () => {
    const api = installFakeApi({
      leads: [makeLead({ id: 3, name: 'Bot Submission', isSpam: true })],
    })
    render(<LeadList isSpam onSessionExpired={vi.fn()} />)
    await screen.findByText('Bot Submission')

    fireEvent.click(screen.getByRole('button', { name: 'Not spam' }))

    await waitForElementToBeRemoved(() => screen.queryByText('Bot Submission'))
    expect(api.leads[0]?.isSpam).toBe(false)
    expect(screen.getByText('Nothing is quarantined.')).toBeDefined()
  })

  it('pages through a list longer than one screenful', async () => {
    const many = Array.from({ length: 60 }, (_, index) => makeLead({ id: index + 1 }))
    const api = installFakeApi({ leads: many })
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)

    expect(await screen.findByText('1–50 of 60')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('51–60 of 60')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true)
    expect(api.calls.some((call) => call.query.get('offset') === '50')).toBe(true)
  })

  it('steps back a page when promoting empties the one being read', async () => {
    const many = Array.from({ length: 51 }, (_, index) => makeLead({ id: index + 1, isSpam: true }))
    installFakeApi({ leads: many })
    render(<LeadList isSpam onSessionExpired={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    expect(await screen.findByText('51–51 of 51')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Not spam' }))

    // The last row on page two is gone, so page two is gone with it — without
    // the step-back the reader would be left looking at an empty table.
    expect(await screen.findByText('Lead 1')).toBeDefined()
    expect(screen.getByText('50 leads')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })

  it('says so when the funnel itself fails to load', async () => {
    const api = installFakeApi({ leads: leads() })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      String(input).includes('/stages')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : (realFetch as typeof fetch)(input as RequestInfo, init),
    )
    render(<LeadList isSpam={false} onSessionExpired={vi.fn()} />)

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(api.calls.length).toBeGreaterThan(0)
  })

  it('hands back to the login screen when the session has expired', async () => {
    const onSessionExpired = vi.fn()
    installFakeApi({ leads: leads(), expired: true })
    render(<LeadList isSpam={false} onSessionExpired={onSessionExpired} />)

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalled())
  })
})
