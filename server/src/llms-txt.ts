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
export function llmsTxt(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '')
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

- ${base}/mcp — MCP over streamable HTTP, POST only. The agent surface; start here.
- ${base}/api/v1/... — REST over the same service layer and the same data.
- ${base}/api/intake/{form_key} — public form intake. No credential, and not for you.
- ${base}/version — {"name":"philo","version":"..."}. No credential.
- ${base}/llms.txt — this file.

Prefer MCP. It carries the tool schemas, the same validation, and instructions
this file would otherwise have to repeat. REST is there for a script that has no
MCP client.

## Credentials

Both machine surfaces take \`Authorization: Bearer <token>\`. Two kinds of token
work, and neither is the operator's password:

1. **An API key**, created by the operator in the app under Settings and shown
   exactly once. Starts \`philo_\`. Reaches /mcp and /api/v1.
2. **An OAuth 2.1 access token**, for a connector client that will not hold a
   static key. Reaches /mcp only.

A browser session cookie also authenticates /api/v1 — that is how the app itself
calls it — but it is not something to obtain programmatically.

### OAuth, if you need it

POST /mcp without a token answers 401 and a \`WWW-Authenticate\` header naming
the protected-resource metadata. From there it is the ordinary discovery chain,
with everything on this same origin:

- ${base}/.well-known/oauth-protected-resource/mcp (RFC 9728)
- ${base}/.well-known/oauth-authorization-server (RFC 8414)
- ${base}/oauth/register — dynamic client registration (RFC 7591), open
- ${base}/oauth/authorize — authorization code + PKCE, S256 only
- ${base}/oauth/token — code exchange and refresh

One scope, \`mcp\`; a requested scope is not honoured and the token response says
so. Access tokens last an hour, refresh tokens thirty days. The operator signs in
and consents on one page, so an unattended client cannot complete the flow.

## What you can do over MCP

Call \`tools/list\` for the schemas. In outline:

- Leads: \`list_leads\` (stage, form, spam, date filters and a full-text
  \`search\`), \`get_lead\` (record plus whole timeline), \`create_lead\`,
  \`update_lead\`, \`move_lead_stage\`, \`add_lead_note\`
- Funnel: \`list_stages\`
- Email: \`list_email_templates\`, \`get_email_template\`,
  \`update_email_template\`, \`preview_email_template\`

## The REST surface

Every path below is under ${base}/api/v1, answers JSON, and refuses an
unauthenticated caller with 401. A state-changing request must send
\`Content-Type: application/json\` — anything else is 415.

- GET /leads — \`?stage=&form=&spam=&search=&createdAfter=&createdBefore=&limit=&offset=\`.
  Newest first, with a total. \`limit\` defaults to 50, maximum 200. \`spam\`
  defaults to false, so the quarantine is opt-in. A filter that does not parse is
  a 400, never a filter silently dropped.
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
- GET /settings/email/templates, PATCH /settings/email/templates/{trigger},
  POST /settings/email/templates/{trigger}/preview — the two templates.

Note there is no \`POST /leads\`. A lead is either submitted through an intake
form or entered through MCP's \`create_lead\`.

An API key deliberately does not reach a few routes that a signed-in operator
does: creating or revoking API keys, push subscriptions, the mail server
settings, and the test-send. Those answer 403 \`session_required\` — the
credential is fine, the route is not for it, so do not re-authenticate.

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
