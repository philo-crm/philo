import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { MCP_SCOPE } from './tokens.ts'

/** Where the agent surface is mounted — see app.ts. */
export const MCP_PATH = '/mcp'

/** RFC 9728 §3.1: the resource path, appended to the well-known prefix. */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`

export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'

/**
 * The RFC 8707 resource identifier a token is issued for. One per instance:
 * Philo is both the authorization server and the only resource server it
 * protects.
 */
export function mcpResourceUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}${MCP_PATH}`
}

export function protectedResourceMetadataUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}${PROTECTED_RESOURCE_METADATA_PATH}`
}

/**
 * RFC 8414. The issuer is the deployment's own base URL, so an instance behind
 * a misconfigured `PHILO_PUBLIC_BASE_URL` advertises endpoints a client cannot
 * reach — which is the same failure mode as every other absolute link Philo
 * builds, and fails visibly at the first redirect rather than silently.
 */
export function authorizationServerMetadata(publicBaseUrl: string): OAuthMetadata {
  return {
    issuer: publicBaseUrl,
    authorization_endpoint: `${publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${publicBaseUrl}/oauth/token`,
    registration_endpoint: `${publicBaseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // OAuth 2.1: PKCE is mandatory and `plain` is gone.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [MCP_SCOPE],
  }
}

export function protectedResourceMetadata(publicBaseUrl: string): OAuthProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(publicBaseUrl),
    authorization_servers: [publicBaseUrl],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Philo',
  }
}

/**
 * RFC 6750 §3, with the RFC 9728 §5.1 hint that tells an MCP client where to
 * begin. `error` only when a credential was actually presented — omitting it is
 * how a client is told to send one rather than to replace the one it has.
 */
export function wwwAuthenticate(publicBaseUrl: string, invalidToken: boolean): string {
  const parts = ['Bearer realm="philo"']
  if (invalidToken) parts.push('error="invalid_token"')
  parts.push(`resource_metadata="${protectedResourceMetadataUrl(publicBaseUrl)}"`)
  return parts.join(', ')
}
