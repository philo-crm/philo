# 0011 — An optional auth header on webhook deliveries, beside the signature

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

[ADR-0010](0010-change-feed-and-webhooks.md) signs every webhook delivery with
`X-Philo-Signature`, an HMAC over the timestamp and body keyed with a secret
Philo generates. That is the stronger scheme: the secret never travels, and a
receiver can refuse a replay.

Many receivers cannot check it. Automation platforms and agent runtimes commonly
accept an inbound webhook only with a fixed key in a header —
`Authorization: Bearer <token>`, or a vendor's own such as `X-Api-Key` — and
offer nowhere to run an HMAC check. Today an operator who wants Philo's changes
in one of those has to run a small proxy that verifies the signature and
re-sends with the key. That is a moving part per deployment for a problem the
sender can solve.

## Options considered

### Option A — a bearer token field

- `bearerToken: "..."`, sent as `Authorization: Bearer ...`.
- Covers the most common receiver, but not one that wants its key in another
  header, and a second option would follow the first request for it.

### Option B — one header, name and value of the registration's choosing

- `authHeader: {name, value}` — `Authorization: Bearer ...`, `X-Api-Key: ...`,
  whatever the receiver documents.
- One field covers both shapes. The name has to be checked so it cannot
  replace a header Philo or HTTP itself relies on.

### Option C — arbitrary extra headers

- A map of headers per registration.
- More than any receiver asked for, and every header becomes something to
  validate, store and keep out of listings.

## Decision

**Option B, in addition to the signature, never instead of it.**

- A registration may carry one `authHeader`, set at creation or later with
  `PATCH /api/v1/webhooks/{id}` (MCP `update_webhook`), which changes that and
  nothing else; `null` removes it. A different URL, scope or set of types is
  still a new registration.
- Every delivery and test ping sends it as given, alongside `X-Philo-Signature`
  and the rest. A receiver that can verify the signature still should.
- The name is an HTTP token and may not be one Philo or the HTTP layer sets:
  `Content-Type`, `Content-Length`, `Host`, `User-Agent`, any `X-Philo-*`, and
  the hop-by-hop headers. The value is printable ASCII on one line — what a key
  is made of, and nothing that could start a header of its own.
- The value is kept as-is, like the signing secret, because it is sent. It is
  never answered back: a registration lists `authHeaderName` only. Unlike the
  secret it is the receiver's to know, so Philo does not show it after the
  request that set it.
- Redirects are still not followed (ADR-0010), so the key goes to the
  registered URL and nowhere else.

## Consequences

- Philo posts straight to receivers that only take a fixed key; no bridge.
- A fixed key, unlike the signature, can be replayed by anyone who sees one
  request. The registered URL should be `https` for a receiver relying on it
  alone; that stays the operator's choice, as the URL already was.
- The key sits in the database in the clear, next to the signing secret, with
  the same exposure: whoever holds the data directory holds both.
- Revisit if receivers start asking for more than one header, or for a scheme
  that needs computing per request.
