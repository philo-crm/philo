import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FunnelBoard } from '../src/FunnelBoard.tsx'
import { FunnelSettings } from '../src/FunnelSettings.tsx'
import { sampleForm } from '../src/IntakeDetails.tsx'
import { installFakeApi, TEST_FUNNELS } from './support/fake-api.ts'

const URL_OF_DEFAULT = TEST_FUNNELS[0]!.forms[0]!.intakeUrl

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('intake details', () => {
  it('shows each funnel its own URL, and copies it', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    installFakeApi()
    render(<FunnelSettings onSessionExpired={vi.fn()} />)

    const panel = await screen.findByRole('form', { name: `${TEST_FUNNELS[0]!.name} funnel` })
    expect(within(panel).getByText(URL_OF_DEFAULT)).toBeDefined()
    fireEvent.click(within(panel).getByRole('button', { name: /intake URL/ }))

    expect(writeText).toHaveBeenCalledWith(URL_OF_DEFAULT)
    expect(await within(panel).findByText('Copied')).toBeDefined()
  })

  it('offers a sample form that posts to the funnel and carries the spam trap', () => {
    const sample = sampleForm('https://philo.example.com/api/intake/abc')
    expect(sample).toContain('action="https://philo.example.com/api/intake/abc"')
    expect(sample).toContain('name="_hp"')
    expect(sample).toContain('name="email"')
  })

  it('is on the board, for the funnel shown', async () => {
    installFakeApi()
    render(<FunnelBoard onSessionExpired={vi.fn()} />)

    const summary = await screen.findByText('Connect a website form')
    expect(within(summary.closest('details')!).getByText(URL_OF_DEFAULT)).toBeDefined()
  })
})
