import { VERSION } from './version.ts'

/**
 * The agent tour — DESIGN.md (MCP surface): a public, hand-written `GET
 * /llms.txt`, the convention carried from Ollie.
 *
 * Hand-written on purpose. A generated listing of routes and JSON schemas is
 * what `tools/list` and the OpenAPI-shaped surfaces already give a client; what
 * an agent arriving cold cannot get anywhere else is which surface to reach for,
 * what a credential is called and where it comes from, and the two or three
 * facts about this CRM that make a call wrong rather than malformed.
 *
 * Unauthenticated, because an agent has to read it before it has a credential.
 * Nothing here is a secret: every path is fixed by the code or by an RFC, and
 * the base URL is the one the caller already used to ask.
 */
export function llmsTxt(publicBaseUrl: string, mcpUrl: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '')
  const mcp = mcpUrl.replace(/\/+$/, '')
  return `# Philo

> Philo is a self-hosted CRM that serves exactly one business. Leads arrive from
> a form on that business's website, move through one funnel of stages, and each
> carries an append-only timeline. There is no tenant, organization or workspace
> to select — this instance is the business.

This file is a hand-written tour of the machine-facing surfaces, for agents and
scripts. It describes this instance: ${base} (philo ${VERSION}).

## Before you write anything

Philo is a pre-screening CRM, not an employment-application system. Never record
government identifiers of any kind — no social security number, no driver's
licence number, no date of birth. Contact details and qualification answers only.

Email templates are live. Editing one changes what the business sends out under
its own name from the next lead onwards.

## Surfaces

- ${mcp} — MCP over streamable HTTP, POST only. The agent surface; start here.
- ${base}/api/v1/... — REST: the API itself. MCP is a client of it.
- ${base}/api/intake/{form_key} — public form intake. No credential, and not for you.
- ${base}/version — {"name":"philo","version":"..."}. No credential.
- ${base}/llms.txt — this file.

Prefer MCP. It carries the tool schemas and instructions this file would
otherwise have to repeat. REST is there for a script that has no MCP client; the
TypeScript SDK, \`@philo/sdk\` in the repository, is the typed way to call it.

## Credentials

Both machine surfaces take \`Authorization: Bearer <token>\`. Two kinds of token
work, and neither is the operator's password:

1. **An API key**, created by the operator in the app under Settings and shown
   exactly once. Starts \`philo_\`.
2. **An OAuth 2.1 access token**, for a connector client that will not hold a
   static key.

Both reach MCP and /api/v1 with the same authority. MCP forwards your token to
the API unchanged, so what one refuses the other refuses too.

### OAuth, if you need it

POST to the MCP endpoint without a token answers 401 and a \`WWW-Authenticate\`
header naming the protected-resource metadata. From there it is the ordinary
discovery chain:

- ${mcp.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp (RFC 9728)
- ${base}/.well-known/openid-configuration (OIDC Discovery; RFC 8414 at
  /.well-known/oauth-authorization-server)
- ${base}/oauth/register — dynamic client registration (RFC 7591), open
- ${base}/oauth/authorize — authorization code + PKCE, S256 only
- ${base}/oauth/token — code exchange and refresh

Your client is granted \`mcp\` whatever it asks for (plus \`openid\` if you
ask), and the token response says so. Access tokens last an hour, refresh
tokens thirty days. The operator signs in and consents on one page, so an
unattended client cannot complete the flow.

## What you can do over MCP

Call \`tools/list\` for the schemas. In outline:

- Leads: \`list_leads\` (stage, form, spam, date filters and a full-text
  \`search\`), \`get_lead\` (record plus whole timeline), \`create_lead\`,
  \`update_lead\`, \`move_lead_stage\`, \`add_lead_note\`
- Funnel: \`list_stages\`, \`create_stage\`, \`update_stage\`,
  \`reorder_stages\`, \`delete_stage\`
- Email: \`list_email_templates\`, \`get_email_template\`,
  \`update_email_template\`, \`preview_email_template\`

## The REST surface

Every path below is under ${base}/api/v1, answers JSON, and refuses an
unauthenticated caller with 401. Bodies are JSON.

- GET /leads — \`?stage=&form=&spam=&search=&createdAfter=&createdBefore=&limit=&offset=\`.
  Newest first, with a total. \`limit\` defaults to 50, maximum 200. \`spam\`
  defaults to false, so the quarantine is opt-in. A filter that does not parse is
  a 400, never a filter silently dropped.
- POST /leads — files a lead by hand: \`name\`, \`email\`, \`phone\`, \`source\`,
  \`stageId\`, \`fields\`. At least one of email or phone. Sends no email.
- GET /leads/{id} — the lead and its timeline.
- PATCH /leads/{id} — \`name\`, \`email\`, \`phone\`. Null clears a field; the lead
  must still have an email or a phone afterwards. The submitted \`fields\` are the
  record of what the applicant sent and are not editable.
- POST /leads/{id}/stage — \`{"stageId": n}\`. Any stage to any stage.
- POST /leads/{id}/notes — \`{"note": "..."}\`. Append-only.
- POST /leads/{id}/not-spam — promotes a quarantined lead and fires the
  notifications that were suppressed when it arrived.
- GET /stages, POST /stages, PATCH /stages/{id}, DELETE /stages/{id},
  POST /stages/reorder — the funnel. A stage holding leads will not delete, and
  neither will the last one left.
- GET /settings/email/templates, GET and PATCH /settings/email/templates/{trigger},
  POST /settings/email/templates/{trigger}/preview — the two templates.

Your credential acts for the person who created the key or approved your
connector, with exactly their authority: everything they can do in the app, you
can do here, including the mail server settings and API keys. What you do is
recorded on each lead's timeline as your credential, not as them.

- GET /auth/principal — whose credential this is, and how the timeline names it.

## Things that will trip you up

- **Stage names are the operator's.** They can be anything. Read \`list_stages\`
  rather than assuming New / Contacted / Qualified / Closed.
- **\`search\` is FTS5, not a query language.** Whole words and word prefixes over
  name, email, phone and the answers in \`fields\`. Type the words, not operators.
- **A lead you create sends no email.** Both templates are written for something
  that just arrived; an acknowledgment would thank someone for a submission they
  never made. Only an intake submission, or a promotion out of spam, sends mail.
- **The timeline is append-only.** A note cannot be edited or removed.
- **Errors are codes.** \`{"error":"not_found"}\`, \`{"error":"invalid_stage"}\`, and
  so on — over MCP, as the text of an error result. Read the code; it says which
  argument to fix.

## Where the rest is written down

- Product and architecture: docs/DESIGN.md in the repository
- Deployment, backup and environment variables: docs/DEPLOYMENT.md
- Source: https://github.com/philo-crm/philo
`
}
