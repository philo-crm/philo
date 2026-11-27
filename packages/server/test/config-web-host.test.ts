import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const EXTERNAL = { PHILO_OIDC_ISSUER: 'https://idp.example.com', PHILO_OIDC_CLIENT_ID: 'philo-web' }

/** ADR-0013: the operator host script, read from the environment only. */
describe('loadConfig — the host script', () => {
  it('loads no host script unless told to', () => {
    expect(loadConfig({}).webHost).toEqual({ scriptUrl: undefined, config: {}, tokenResources: [] })
    expect(loadConfig({ PHILO_WEB_HOST_SCRIPT_URL: '' }).webHost.scriptUrl).toBeUndefined()
  })

  it.each([
    ['/host/chrome.js', '/host/chrome.js'],
    ['/host/chrome.js?v=3', '/host/chrome.js?v=3'],
    ['https://chrome.example.com/v1/host.js', 'https://chrome.example.com/v1/host.js'],
    ['https://chrome.example.com:8443/v1/host.js?v=3', 'https://chrome.example.com:8443/v1/host.js?v=3'],
    ['http://localhost:5174/host.js', 'http://localhost:5174/host.js'],
    ['http://127.0.0.1:5174/host.js', 'http://127.0.0.1:5174/host.js'],
  ])('takes %s as a host script URL', (raw, expected) => {
    expect(loadConfig({ PHILO_WEB_HOST_SCRIPT_URL: ` ${raw} ` }).webHost.scriptUrl).toBe(expected)
  })

  it.each([
    ['host.js'],
    ['//chrome.example.com/host.js'],
    ['/\\chrome.example.com/host.js'],
    ['/host/../uploads/x.js'],
    ['/host.js#x'],
    ['/host js'],
    ['http://chrome.example.com/host.js'],
    ['javascript:alert(1)'],
    ['data:text/javascript,1'],
    ['ftp://chrome.example.com/host.js'],
    ['https://user@chrome.example.com/host.js'],
    ['https://chrome.example.com/host.js#x'],
    ['https://*.example.com/host.js'],
    ['https://chrome.example.com/a;script-src/host.js'],
    ['https://chrome.example.com/a,b/host.js'],
    ["https://chrome.example.com/a'b/host.js"],
    ['https://chrome.example.com/a/../host.js'],
    ['https://chrome.example.com/%2e%2e/host.js'],
  ])('refuses %s as a host script URL', (raw) => {
    expect(() => loadConfig({ PHILO_WEB_HOST_SCRIPT_URL: raw })).toThrow(/PHILO_WEB_HOST_SCRIPT_URL/)
  })

  it('hands the host config through as parsed JSON', () => {
    const config = loadConfig({
      PHILO_WEB_HOST_SCRIPT_URL: '/host.js',
      PHILO_WEB_HOST_CONFIG: '{"feedUrl":"https://feed.example.com","nested":{"on":true}}',
    })
    expect(config.webHost.config).toEqual({ feedUrl: 'https://feed.example.com', nested: { on: true } })
  })

  it.each([['not json'], ['[1,2]'], ['null'], ['"text"'], ['42']])(
    'refuses %s as the host config',
    (raw) => {
      expect(() => loadConfig({ PHILO_WEB_HOST_SCRIPT_URL: '/host.js', PHILO_WEB_HOST_CONFIG: raw })).toThrow(
        /PHILO_WEB_HOST_CONFIG/,
      )
    },
  )

  it('takes token resources as written, trimmed, blanks dropped', () => {
    const config = loadConfig({
      ...EXTERNAL,
      PHILO_WEB_HOST_SCRIPT_URL: '/host.js',
      PHILO_WEB_HOST_TOKEN_RESOURCES: ' https://feed.example.com, ,https://idp.example.com/api',
    })
    expect(config.webHost.tokenResources).toEqual(['https://feed.example.com', 'https://idp.example.com/api'])
  })

  it.each([['feed'], ['https://feed.example.com#x'], ['ftp://feed.example.com'], ['urn:example:feed']])(
    'refuses %s as a token resource',
    (raw) => {
      expect(() =>
        loadConfig({ ...EXTERNAL, PHILO_WEB_HOST_SCRIPT_URL: '/host.js', PHILO_WEB_HOST_TOKEN_RESOURCES: raw }),
      ).toThrow(/PHILO_WEB_HOST_TOKEN_RESOURCES/)
    },
  )

  it.each([['https://crm.example.com/api'], ['https://crm.example.com/api/']])(
    'refuses Philo’s own audience (%s) as a token resource',
    (raw) => {
      expect(() =>
        loadConfig({
          ...EXTERNAL,
          PHILO_OIDC_AUDIENCE: 'https://crm.example.com/api',
          PHILO_WEB_HOST_SCRIPT_URL: '/host.js',
          PHILO_WEB_HOST_TOKEN_RESOURCES: raw,
        }),
      ).toThrow(/PHILO_WEB_HOST_TOKEN_RESOURCES.*own/)
    },
  )

  it('refuses a resource Philo’s own sign-in asks for as a token resource', () => {
    expect(() =>
      loadConfig({
        ...EXTERNAL,
        PHILO_OIDC_RESOURCE: 'https://crm.example.com/api',
        PHILO_WEB_HOST_SCRIPT_URL: '/host.js',
        PHILO_WEB_HOST_TOKEN_RESOURCES: 'https://crm.example.com/api',
      }),
    ).toThrow(/PHILO_WEB_HOST_TOKEN_RESOURCES.*own/)
  })

  it.each([['https://crm.example.com'], ['https://crm.example.com/'], ['https://crm.example.com/mcp']])(
    'refuses the server’s own URL (%s) as a token resource with the built-in IdP',
    (raw) => {
      expect(() =>
        loadConfig({
          PHILO_PUBLIC_BASE_URL: 'https://crm.example.com',
          PHILO_WEB_HOST_SCRIPT_URL: '/host.js',
          PHILO_WEB_HOST_TOKEN_RESOURCES: raw,
        }),
      ).toThrow(/PHILO_WEB_HOST_TOKEN_RESOURCES.*own/)
    },
  )

  // A setting that would silently do nothing is refused rather than ignored.
  it.each([['PHILO_WEB_HOST_CONFIG', '{}'], ['PHILO_WEB_HOST_TOKEN_RESOURCES', 'https://feed.example.com']])(
    'refuses %s without a host script',
    (name, value) => {
      expect(() => loadConfig({ ...EXTERNAL, [name]: value })).toThrow(new RegExp(`${name} needs PHILO_WEB_HOST_SCRIPT_URL`))
    },
  )
})
