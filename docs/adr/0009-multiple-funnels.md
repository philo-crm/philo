# 0009 — Multiple funnels per instance, with funnel-scoped settings

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

One instance serves one business, permanently. It does not follow that a
business has one intake flow. The first deployment recruits drivers; the same
operator may also want a second flow — owner-operators, dispatchers, a sales
inquiry form — that has its own stages, its own acknowledgment email, and
different people who need to hear about each new lead. Today every one of those
is instance-wide: one stage list, one pair of templates, one sender identity,
and the notification goes to everyone with a login.

The kickoff design bought this door on purpose: `pipelines` was seeded with one
Default row and every stage hangs off it, and `intake_forms` exists so that "a
second form, same instance" would be possible (DESIGN.md, Data model). What is
missing is everything a second flow needs besides stages: its own forms, its
own templates, and its own sender settings — while the parts that are about the
instance rather than the flow (the mail server, the business) stay shared.

## Options considered

### Option A — a separate instance per flow

- No code.
- Two logins, two databases, two SMTP configurations, two of everything an
  operator would have to keep in step; a lead that applied to the wrong flow
  cannot be moved. Single-tenancy is about one *business*, not one form.

### Option B — tags on leads, one funnel

- Small: a column and a filter.
- The stages, the templates and the recipients are exactly what differs between
  flows, and a tag scopes none of them.

### Option C — funnels own stages, forms, templates and sender settings

- Each funnel is a self-contained intake flow; the instance-level settings stay
  instance-level.
- Every route that assumed "the" pipeline needs a scope, and the PWA needs a way
  to say which funnel it is looking at.

## Decision

**Option C.** A **funnel** is a row of `pipelines` — the table keeps its name,
so no migration has to rebuild it and every foreign key into it; the API, SDK,
MCP and PWA all say *funnel*.

A funnel owns:

- **Stages** — as before, through `stages.pipeline_id`.
- **Intake forms** — `intake_forms.pipeline_id`. A submission is filed under
  the first stage of its form's funnel. A form whose funnel is unset (rows
  written before this column existed) belongs to the default funnel.
- **Email templates** — one row per `(pipeline_id, trigger)`, replacing the
  instance-wide unique `trigger`.
- **Funnel-scoped email settings**, columns on `pipelines`:
  - `from_name` — the From display name, e.g. "Acme Recruiting".
  - `reply_to` — where replies to the acknowledgment land.
  - `notify_recipients` — who gets the new-lead notification.

  Each is an override: empty inherits the instance value (the global sender
  name, the global reply-to, everyone who can sign in).

Instance-wide, and staying in `settings`: the SMTP server and its credentials,
the From **address** (a provider verifies the sending domain, so it is a fact
about the mail server, not the flow), and the business name.

A lead belongs to the funnel its current stage belongs to; there is no
`leads.pipeline_id` to drift out of agreement with it. Moving a lead to a stage
in another funnel is allowed — that is how a lead that applied through the
wrong flow is corrected — and it sends nothing: emails fire at creation only
(DESIGN.md, Email).

**The default funnel is the lowest-numbered one.** Every route that took no
funnel before still takes none and acts on the default, so no existing client
breaks; a funnel is chosen with `?funnel=<id>` on the collection routes
(`/stages`, `/leads`, `/settings/email/templates`) and `funnelId` on a created
lead.

A new funnel is born usable: the default stages, the two default templates and
one intake form are created with it, in one transaction. A funnel can be
deleted only when it holds no leads and is not the last one; its stages,
templates and forms go with it, so its form keys stop answering.

Templates gain `{{funnel.name}}`.

## Consequences

- A second intake flow is a click in settings, not a second deployment.
- Notification recipients become configurable, which DESIGN.md had declined
  for a single funnel. The default is unchanged — empty still means everyone
  who can sign in — so an operator with one funnel never sees the difference.
- The PWA carries a funnel selector on the board, the lead list and the
  template editor. A lead's own screen offers the stages of its own funnel.
- Still no per-funnel SMTP server, From address or business name. If a
  business ever needs a flow sent from a different domain, that is a new
  decision, not an override added here.
- Still no forms-management UI beyond what a funnel shows: each funnel lists
  its forms' intake URLs; rotating a key or editing allowed origins remains a
  later change.
