import { createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createSmtpSender, smtpGreetingName } from '../src/email/transport.ts'
import { TEST_EMAIL_SETTINGS } from './support/app.ts'

describe('smtpGreetingName', () => {
  it.each([
    ['https://crm.example.com', 'crm.example.com'],
    ['https://crm.example.com:8443/base', 'crm.example.com'],
    ['http://203.0.113.7:3000', '[203.0.113.7]'],
    ['http://[2001:db8::1]:3000', '[IPv6:2001:db8::1]'],
    ['http://localhost:3000', undefined],
    ['http://philo:3000', undefined],
    ['http://app.localhost:3000', undefined],
  ])('%s greets as %s', (url, expected) => {
    expect(smtpGreetingName(url)).toBe(expected)
  })
})

describe('createSmtpSender', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
    server = undefined
  })

  /** An SMTP server that hears the greeting and then refuses it, as a strict relay does. */
  function refusingRelay(): Promise<{ port: number; greeting: Promise<string> }> {
    let heard: (line: string) => void
    const greeting = new Promise<string>((resolve) => { heard = resolve })
    server = createServer((socket) => {
      socket.write('220 relay.example.com ESMTP\r\n')
      socket.once('data', (chunk) => {
        heard(chunk.toString().trim())
        socket.end('421 4.7.0 Try again later, closing connection.\r\n')
      })
    })
    return new Promise((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        resolve({ port: (server!.address() as AddressInfo).port, greeting })
      })
    })
  }

  it('greets the server with the configured name', async () => {
    const relay = await refusingRelay()
    const send = createSmtpSender('crm.example.com')({
      ...TEST_EMAIL_SETTINGS,
      smtpHost: '127.0.0.1',
      smtpPort: relay.port,
      smtpSecure: false,
    })
    await expect(send({ to: ['dana@example.com'], subject: 'Hi', html: '<p>Hi</p>' })).rejects.toThrow()
    expect(await relay.greeting).toBe('EHLO crm.example.com')
  })
})
