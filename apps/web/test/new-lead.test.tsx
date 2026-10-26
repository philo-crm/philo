import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewLead } from '../src/NewLead.tsx'
import { installFakeApi } from './support/fake-api.ts'

afterEach(() => {
  window.history.pushState(null, '', '/')
})

function field(name: string) {
  return screen.getByLabelText(name)
}

describe('NewLead', () => {
  it('files a lead in the chosen stage and opens it', async () => {
    const api = installFakeApi()
    render(<NewLead onSessionExpired={vi.fn()} />)
    await screen.findByRole('option', { name: 'Contacted' })

    fireEvent.change(field('Name'), { target: { value: 'Riley Moss' } })
    fireEvent.change(field('Phone'), { target: { value: '555-0100' } })
    fireEvent.change(field('Source'), { target: { value: 'Phone call' } })
    fireEvent.change(field('Stage'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }))

    await waitFor(() => expect(window.location.pathname).toMatch(/^\/leads\/\d+$/))
    const created = api.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/leads')
    expect(created?.body).toEqual({ name: 'Riley Moss', phone: '555-0100', source: 'Phone call', funnelId: 1, stageId: 2 })
    expect(api.leads.at(-1)).toMatchObject({ name: 'Riley Moss', stageName: 'Contacted' })
  })

  it('asks for a way to reach them before sending anything', async () => {
    const api = installFakeApi()
    render(<NewLead onSessionExpired={vi.fn()} />)
    await screen.findByRole('option', { name: 'New' })

    fireEvent.change(field('Name'), { target: { value: 'Nobody' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add lead' }))

    expect((await screen.findByRole('alert')).textContent).toContain('email address or a phone number')
    expect(api.calls.some((call) => call.method === 'POST' && call.path === '/api/v1/leads')).toBe(false)
  })

  it('says no email goes out', async () => {
    installFakeApi()
    render(<NewLead onSessionExpired={vi.fn()} />)
    expect(await screen.findByText(/No email is sent/)).toBeDefined()
  })
})
