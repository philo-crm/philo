import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('applies defaults when nothing is set', () => {
    const config = loadConfig({})
    expect(config.port).toBe(3000)
    expect(config.dataDir).toBe(resolve('data'))
    expect(config.publicBaseUrl).toBe('http://localhost:3000')
  })

  it('reads every env var', () => {
    const config = loadConfig({
      PHILO_PORT: '8080',
      PHILO_DATA_DIR: '/srv/philo-data',
      PHILO_PUBLIC_BASE_URL: 'https://crm.example.com',
      PHILO_TRUSTED_PROXY_HOPS: '1',
    })
    expect(config).toEqual({
      port: 8080,
      dataDir: '/srv/philo-data',
      publicBaseUrl: 'https://crm.example.com',
      trustedProxyHops: 1,
    })
  })

  it('trusts no proxy unless told to', () => {
    expect(loadConfig({}).trustedProxyHops).toBe(0)
  })

  it('resolves a relative data dir to an absolute path', () => {
    expect(loadConfig({ PHILO_DATA_DIR: './var/state' }).dataDir).toBe(resolve('var/state'))
  })

  it.each(['PHILO_PORT', 'PHILO_DATA_DIR', 'PHILO_PUBLIC_BASE_URL', 'PHILO_TRUSTED_PROXY_HOPS'])(
    'treats an empty %s as unset',
    (key) => {
      expect(loadConfig({ [key]: '' })).toEqual(loadConfig({}))
    },
  )

  it('defaults the public base url to the configured port', () => {
    expect(loadConfig({ PHILO_PORT: '8080' }).publicBaseUrl).toBe('http://localhost:8080')
  })

  it('strips a trailing slash from the public base url', () => {
    expect(loadConfig({ PHILO_PUBLIC_BASE_URL: 'https://crm.example.com/' }).publicBaseUrl).toBe(
      'https://crm.example.com',
    )
  })

  it.each(['0', '65536', 'abc', '3000.5', '-1'])('rejects PHILO_PORT=%s', (port) => {
    expect(() => loadConfig({ PHILO_PORT: port })).toThrow(/PHILO_PORT/)
  })

  it.each(['-1', '1.5', 'abc', '9'])('rejects PHILO_TRUSTED_PROXY_HOPS=%s', (hops) => {
    expect(() => loadConfig({ PHILO_TRUSTED_PROXY_HOPS: hops })).toThrow(/PHILO_TRUSTED_PROXY_HOPS/)
  })

  it.each(['not-a-url', 'ftp://crm.example.com', '/relative'])(
    'rejects PHILO_PUBLIC_BASE_URL=%s',
    (url) => {
      expect(() => loadConfig({ PHILO_PUBLIC_BASE_URL: url })).toThrow(/PHILO_PUBLIC_BASE_URL/)
    },
  )
})
