import type { OAuthProtectedResourceMetadata, OpenIdProviderDiscoveryMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { ID_TOKEN_ALG } from './signing-key.ts'
import { MCP_SCOPE, OPENID_SCOPE, OPERATOR_SCOPE } from './tokens.ts'

export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'
export const OPENID_CONFIGURATION_PATH = '/.well-known/openid-configuration'
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'

/** RFC 8414 §2 names the revocation fields; the SDK's OIDC type predates them. */
export type ProviderMetadata = OpenIdProviderDiscoveryMetadata & {
  revocation_endpoint: string
  revocation_endpoint_auth_methods_supported: string[]
}

/**
 * RFC 8414 and OIDC Discovery in one document — the latter is a superset, and
 * clients read whichever path they know. The issuer is the deployment's own
 * base URL, so an instance behind a misconfigured `PHILO_PUBLIC_BASE_URL`
 * advertises endpoints a client cannot reach — which fails visibly at the first
 * redirect rather than silently.
 */
export function authorizationServerMetadata(publicBaseUrl: string): ProviderMetadata {
  return {
    issuer: publicBaseUrl,
    authorization_endpoint: `${publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${publicBaseUrl}/oauth/token`,
    registration_endpoint: `${publicBaseUrl}/oauth/register`,
    revocation_endpoint: `${publicBaseUrl}/oauth/revoke`,
    userinfo_endpoint: `${publicBaseUrl}/oauth/userinfo`,
    jwks_uri: `${publicBaseUrl}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // OAuth 2.1: PKCE is mandatory and `plain` is gone.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: [OPENID_SCOPE, OPERATOR_SCOPE, MCP_SCOPE],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [ID_TOKEN_ALG],
    claims_supported: ['sub', 'email', 'name'],
  }
}

/**
 * RFC 9728 for the API itself. The MCP app publishes its own, naming the same
 * authorization server — it is a separate resource that forwards the token
 * here (ADR-0006).
 */
export function protectedResourceMetadata(publicBaseUrl: string, issuer: string): OAuthProtectedResourceMetadata {
  return {
    resource: publicBaseUrl,
    authorization_servers: [issuer],
    scopes_supported: [OPERATOR_SCOPE, MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Philo API',
  }
}
