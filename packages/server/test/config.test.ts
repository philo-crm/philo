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
      PHILO_TRUSTED_PROXY: 'true',
      PHILO_APP_URL: 'https://app.example.com/',
      PHILO_MCP_URL: 'https://agents.example.com/mcp',
      PHILO_OIDC_ISSUER: 'https://idp.example.com/realms/philo',
      PHILO_OIDC_AUDIENCE: 'philo-api',
      PHILO_OIDC_CLIENT_ID: 'philo-web',
      PHILO_OIDC_AGENT_CLIENT_IDS: ' connector-a, ,connector-b,philo-web',
      PHILO_OIDC_SCOPE: ' openid  email profile offline_access ',
      PHILO_OIDC_RESOURCE: ' https://crm.example.com/api, ,https://agents.example.com/mcp',
      PHILO_WEB_CONNECT_ORIGINS: ' https://token.example-apis.com, ,https://revoke.example.net/',
    })
    expect(config).toEqual({
      port: 8080,
      dataDir: '/srv/philo-data',
      publicBaseUrl: 'https://crm.example.com',
      trustProxy: true,
      appUrl: 'https://app.example.com',
      mcpUrl: 'https://agents.example.com/mcp',
      externalIdp: {
        issuer: 'https://idp.example.com/realms/philo',
        audience: ['philo-api'],
        clientId: 'philo-web',
        // Trimmed, blanks dropped, and the operator's own client never doubles as an agent.
        agentClientIds: ['connector-a', 'connector-b'],
        // Whitespace collapsed; resource indicators kept exactly as written, blanks dropped.
        scope: 'openid email profile offline_access',
        resource: ['https://crm.example.com/api', 'https://agents.example.com/mcp'],
      },
      // Trimmed, blanks dropped, and normalized to the bare origin.
      webConnectOrigins: ['https://token.example-apis.com', 'https://revoke.example.net'],
      webHost: { scriptUrl: undefined, config: {}, tokenResources: [] },
      webAssetOrigins: [],
    })
  })

  it('serves the app and the MCP endpoint from the public base URL by default', () => {
    const config = loadConfig({ PHILO_PUBLIC_BASE_URL: 'https://crm.example.com' })
    expect(config.appUrl).toBe('https://crm.example.com')
    expect(config.mcpUrl).toBe('https://crm.example.com/mcp')
    expect(config.externalIdp).toBeUndefined()
  })

  it('refuses an external issuer without the client id that marks the operator', () => {
    expect(() => loadConfig({ PHILO_OIDC_ISSUER: 'https://idp.example.com' })).toThrow(/PHILO_OIDC_CLIENT_ID/)
  })

  it('asks an external IdP for the default scope and no resource unless told otherwise', () => {
    const config = loadConfig({ PHILO_OIDC_ISSUER: 'https://idp.example.com', PHILO_OIDC_CLIENT_ID: 'x' })
    expect(config.externalIdp).toMatchObject({ scope: 'openid email profile', resource: [] })
  })

  it('refuses a sign-in scope without openid', () => {
    const env = { PHILO_OIDC_ISSUER: 'https://idp.example.com', PHILO_OIDC_CLIENT_ID: 'x' }
    expect(() => loadConfig({ ...env, PHILO_OIDC_SCOPE: 'email profile' })).toThrow(/PHILO_OIDC_SCOPE.*openid/)
    // A scope token is compared whole: "openidx" is not "openid".
    expect(() => loadConfig({ ...env, PHILO_OIDC_SCOPE: 'openidx email' })).toThrow(/PHILO_OIDC_SCOPE/)
  })

  it('refuses a resource indicator that is not an absolute URL, or carries a fragment', () => {
    const env = { PHILO_OIDC_ISSUER: 'https://idp.example.com', PHILO_OIDC_CLIENT_ID: 'x' }
    expect(() => loadConfig({ ...env, PHILO_OIDC_RESOURCE: 'philo-api' })).toThrow(/PHILO_OIDC_RESOURCE/)
    expect(() => loadConfig({ ...env, PHILO_OIDC_RESOURCE: 'https://api.example.com/#x' })).toThrow(
      /PHILO_OIDC_RESOURCE/,
    )
  })

  it('refuses sign-in scope or resource settings without an external issuer to send them to', () => {
    expect(() => loadConfig({ PHILO_OIDC_SCOPE: 'openid offline_access' })).toThrow(/PHILO_OIDC_ISSUER/)
    expect(() => loadConfig({ PHILO_OIDC_RESOURCE: 'https://api.example.com' })).toThrow(/PHILO_OIDC_ISSUER/)
  })

  it.each([
    [' https://crm.example.com/api, ,https://crm.example.com/mcp ,', ['https://crm.example.com/api', 'https://crm.example.com/mcp']],
    ['philo-api', ['philo-api']],
    // Empty means no audience check, exactly as unset.
    ['', undefined],
  ])('reads PHILO_OIDC_AUDIENCE=%j as a list, dropping blanks', (raw, expected) => {
    const config = loadConfig({ PHILO_OIDC_ISSUER: 'https://idp.example.com', PHILO_OIDC_CLIENT_ID: 'x', PHILO_OIDC_AUDIENCE: raw })
    expect(config.externalIdp?.audience).toEqual(expected)
  })

  // Set but naming nothing (say, a template whose variables were all unset)
  // must not quietly turn the audience check off.
  it.each([' ', ',', ' , '])('refuses PHILO_OIDC_AUDIENCE=%j, which lists no audience', (raw) => {
    expect(() =>
      loadConfig({ PHILO_OIDC_ISSUER: 'https://idp.example.com', PHILO_OIDC_CLIENT_ID: 'x', PHILO_OIDC_AUDIENCE: raw }),
    ).toThrow(/PHILO_OIDC_AUDIENCE/)
  })

  it('refuses an issuer that is not a URL', () => {
    expect(() => loadConfig({ PHILO_OIDC_ISSUER: 'idp', PHILO_OIDC_CLIENT_ID: 'x' })).toThrow(/PHILO_OIDC_ISSUER/)
  })

  it('adds no extra connect origins unless told to', () => {
    expect(loadConfig({}).webConnectOrigins).toEqual([])
    expect(loadConfig({ PHILO_WEB_CONNECT_ORIGINS: '' }).webConnectOrigins).toEqual([])
  })

  it('accepts plain http only for a local development origin', () => {
    expect(
      loadConfig({ PHILO_WEB_CONNECT_ORIGINS: 'http://localhost:8080,http://127.0.0.1:9000,https://A.example.com:8443' })
        .webConnectOrigins,
    ).toEqual(['http://localhost:8080', 'http://127.0.0.1:9000', 'https://a.example.com:8443'])
  })

  it.each([
    ["'self'"],
    ["'unsafe-inline'"],
    ['*'],
    ['https://*.example.com'],
    ['https:'],
    ['data:'],
    ['blob:'],
    ['example.com'],
    ['http://token.example.com'],
    ['https://token.example.com/oauth/token'],
    ['https://token.example.com?x=1'],
    ['https://token.example.com#x'],
    ['https://user@token.example.com'],
    ['https://token.example.com;script-src *'],
    ['https://token.example.com https://other.example.com'],
    ['wss://feed.example.com'],
  ])('refuses %s as an extra connect origin', (entry) => {
    expect(() => loadConfig({ PHILO_WEB_CONNECT_ORIGINS: `https://ok.example.com,${entry}` })).toThrow(
      /PHILO_WEB_CONNECT_ORIGINS/,
    )
  })

  it('trusts no proxy unless told to', () => {
    expect(loadConfig({}).trustProxy).toBe(false)
  })

  it.each(['true', 'TRUE', ' true ', '1'])('reads PHILO_TRUSTED_PROXY=%s as trusted', (raw) => {
    expect(loadConfig({ PHILO_TRUSTED_PROXY: raw }).trustProxy).toBe(true)
  })

  it.each(['false', 'FALSE', '0'])('reads PHILO_TRUSTED_PROXY=%s as untrusted', (raw) => {
    expect(loadConfig({ PHILO_TRUSTED_PROXY: raw }).trustProxy).toBe(false)
  })

  it('resolves a relative data dir to an absolute path', () => {
    expect(loadConfig({ PHILO_DATA_DIR: './var/state' }).dataDir).toBe(resolve('var/state'))
  })

  it.each(['PHILO_PORT', 'PHILO_DATA_DIR', 'PHILO_PUBLIC_BASE_URL', 'PHILO_TRUSTED_PROXY'])(
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

  // A security question must not be decided by a typo reading as truthy.
  it.each(['flase', 'yes', 'no', '2', 'on'])('rejects PHILO_TRUSTED_PROXY=%s', (raw) => {
    expect(() => loadConfig({ PHILO_TRUSTED_PROXY: raw })).toThrow(/PHILO_TRUSTED_PROXY/)
  })

  it.each(['not-a-url', 'ftp://crm.example.com', '/relative'])(
    'rejects PHILO_PUBLIC_BASE_URL=%s',
    (url) => {
      expect(() => loadConfig({ PHILO_PUBLIC_BASE_URL: url })).toThrow(/PHILO_PUBLIC_BASE_URL/)
    },
  )
})
