# Philo

A self-hosted, open-source **CRM** for small businesses.

Philo captures leads from your website, moves them through a funnel you define,
and notifies you the moment a new one arrives — push to your phone, email to
your inbox, and an acknowledgment to the person who applied or inquired.

**Deployment model: one instance per business.** Philo is deliberately
single-tenant. There is no organizations table, no tenant isolation, no plan
tiers — and there never will be. That simplicity is the product.

> **Status: pre-alpha.** The scaffold boots and serves a health endpoint; none
> of the MVP features below are built yet. See [docs/](docs/) for the design
> document and [docs/adr/](docs/adr/) for architecture decision records.

## What Philo will do (MVP)

- **Lead intake endpoint** — a form on your existing website POSTs to Philo;
  Philo creates the lead.
- **Lead management** — view leads, see detail, move them through a funnel
  whose stages you define in the app.
- **PWA with push notifications** — a new lead pings your phone.
- **Customizable email** — notification to you, acknowledgment to the
  submitter, both templates editable in-app.

## What Philo will not do

- Multi-tenancy. One business, one instance, forever.
- DOT driver qualification files, FMCSA employment applications, background
  checks, MVR pulls, or anything FCRA-regulated. Philo's recruiting use case
  is pre-screening only, and it keeps collected PII minimal by design.

## Naming

| Thing | Value |
|---|---|
| Product name | Philo |
| Binary / package | `philo` |
| Docker image | `ghcr.io/philo-crm/philo` |
| Env var prefix | `PHILO_` |
| Database name | `philo` |
| Config dir | `~/.config/philo/` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Philo is a sibling project of
[ollie](https://github.com/olliefms/ollie) and follows the same conventions:
DCO sign-off, conventional commits, trunk-based releases.

## License

[AGPL-3.0](LICENSE)
