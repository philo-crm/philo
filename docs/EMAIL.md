# Email setup

Philo sends two emails, both on a lead arriving:

- **`new_lead_notify`** — to the business, saying a lead came in.
- **`new_lead_ack`** — to the person who submitted, acknowledging it.

Email is the *guaranteed* notification channel
([ADR-0004](adr/0004-push-best-effort-email-guaranteed.md)); push is the fast
one and is allowed to fail. So this is the part of setup worth doing carefully:
an instance with no SMTP configured looks identical, from the outside, to one
that works. Nothing but the boot log says otherwise.

Philo speaks plain SMTP and has no provider integration. Any provider works
without code changes; [Resend](#resend) is walked through below because it is
the fastest to get sending, not because it is special.

## Configure it

Everything is on the **Settings** screen, in three groups — Mail server, Sender,
Business — and none of it is an environment variable.

| Group | Field | What to put in it |
|---|---|---|
| Mail server | SMTP host | Your provider's submission host, e.g. `smtp.resend.com`. |
| Mail server | Port | `587` for STARTTLS (the usual choice) or `465` for implicit TLS. |
| Mail server | TLS from the start | On for port 465, off for 587. |
| Mail server | Username | Whatever the provider calls it — often an API key name, or your account address. |
| Mail server | Password | The provider's API key or app password. Write-only: once saved it is never sent back to the browser, and leaving the box blank keeps it. |
| Sender | From name | The display name on outgoing mail, e.g. your business name. |
| Sender | From address | The address mail is sent from. Must be on a domain the provider has verified for you. |
| Sender | Reply-to | Where replies land. Set this to a **real inbox someone reads** — Philo does not receive email. |
| Business | Business name | Fills `{{business.name}}` in templates. |

Save, then use **Test** at the bottom of the page to send yourself a message. It
sends with the settings as *stored*, not as typed, so a green result is a
statement about what the next real lead will be sent with.

## Resend

1. Sign up and **add your domain**, then publish the DNS records Resend gives
   you. There will be an SPF record and a DKIM record; add both. Wait for the
   dashboard to show the domain verified — mail sent before that will be
   rejected or land in spam.
2. Create an **API key** with sending permission. Copy it; it is shown once.
3. In Philo's Settings → Mail server:
   - SMTP host: `smtp.resend.com`
   - Port: `587`, TLS from the start: off
   - Username: `resend`
   - Password: the API key, pasted whole (it starts `re_`)
4. Sender: a From address on the domain you verified — `no-reply@example.com`
   is a fine choice — and a Reply-to pointing at your real inbox.
5. Save, then send yourself a test.

Resend's free tier is metered per month and per day. Two emails per lead is a
small number, but it is not zero; check the current limits against how many
leads you expect.

## Any other SMTP provider

The five things you need from any provider are the same: **host, port,
username, password, and a verified sending domain.** Postmark, Mailgun, SES,
Fastmail, a self-hosted Postfix — all of them fit the table above.

Two rules of thumb:

- **Port 587 with "TLS from the start" off** is the right answer almost
  everywhere. Use 465 with it on only if the provider says so.
- **Do not use a personal Gmail or Outlook account.** Consumer mail providers
  throttle and eventually block automated sending, and the failure shows up as
  leads you never heard about.

### Deliverability

Philo cannot help with this part; it belongs to your provider and your DNS.

- **SPF and DKIM** for the sending domain, both, as the provider instructs.
- **DMARC** once those pass — start at `p=none` and read the reports before
  tightening.
- **The From address must be on the verified domain.** Sending as
  `you@gmail.com` through a provider that verified `example.com` fails DMARC
  and lands in spam.
- The acknowledgment carries your **Reply-to**, so a candidate who replies
  reaches a person. That address is worth getting right even if nothing else is.

## What triggers a send

**A submission, not every new row.** Email goes out when a lead arrives through
an intake form, and when a quarantined lead is promoted with "not spam". A lead
you or an agent *enters* — through MCP's `create_lead`, or a phone screen typed
up afterwards — sends nothing: the acknowledgment would thank someone for an
application they never submitted, and the notification would announce a lead to
the operator whose own agent filed it.

Honeypot-flagged submissions send nothing either, until you promote them.

The notification goes to **the email address of every Philo account** — there is
no separate "notify this address" setting, because the accounts are the people
who would read it. The acknowledgment goes to the lead's own address, and a lead
that left only a phone number gets none.

Every send is recorded as an `email_sent` event on the lead's timeline, so the
lead detail screen is where you check whether something actually went out.

### When the mail server is down

A failed send gets five attempts in all — the first, then four retries waiting
roughly 1, 2, 4 and 8 minutes, about a quarter of an hour end to end. That is
shaped around greylisting, where a receiver refuses a first-time sender and
accepts the same message minutes later; a single attempt would turn a routine
defence into a permanently missed lead. After the fifth attempt Philo gives up
and says so on the lead's timeline.

Retry schedules live in memory, so a restart mid-backoff would forget them. To
cover that, every boot sweeps the last 24 hours for leads still owed an email
and picks them up. That window is also what makes "configure SMTP the morning
after the first lead arrived" work.

## Templates

**Settings → Email templates** edits both. They are Handlebars, stored in the
database. The body is HTML and a variable in it is escaped, so whatever a
stranger typed into your form cannot inject markup; the subject is plain text
and is not escaped, because escaping it would put `&amp;` in your inbox.

Available variables:

| Variable | What it is |
|---|---|
| `{{lead.name}}`, `{{lead.email}}`, `{{lead.phone}}` | Contact details, as submitted. |
| `{{lead.source}}` | The intake form's name, or whatever an entered lead was given. |
| `{{lead.fields.*}}` | Anything else the form submitted — `{{lead.fields.years_experience}}` and so on. Field names come from your form. |
| `{{business.name}}` | From Settings → Business. |
| `{{lead_url}}` | A link straight to the lead, built from `PHILO_PUBLIC_BASE_URL`. |

The editor previews without saving, so you can iterate freely, and there is a
test-send that mails the rendered result to whoever is signed in — the only way
to see how it actually looks in a mail client. Source that does not compile is
refused with the message Handlebars gave, and nothing is saved.

Each template can be switched off. Turning off `new_lead_notify` turns off the
guaranteed notification channel, which is a real decision rather than a
preference — push is best-effort and will not cover for it.

An agent with an API key can edit templates too (`update_email_template` over
MCP), which is deliberate: designing the emails is part of what the agent
surface is for. It is also why an API key is a credential to hand out
carefully — it can author what goes out under your business's name.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Boot log warns SMTP is not configured | Host or From address is empty. Both are required before anything is attempted. |
| Test send fails with a 502 | The SMTP server refused. The error detail is the provider's own message — usually a wrong password or an unverified sender domain. |
| Test send fails with a 409 | Nothing is configured to send *with* yet. Save the settings first. |
| Mail sends but lands in spam | SPF/DKIM incomplete, or the From address is not on the verified domain. |
| The business email arrives, the acknowledgment does not | The lead had no email address — only a phone number. Nothing to acknowledge to. |
| Nothing sends for a lead you created over MCP or REST | Working as intended; see [What triggers a send](#what-triggers-a-send). |
| A template edit did not take effect | Check the timeline: the send may have happened before the edit. Templates apply from the next lead onwards. |
