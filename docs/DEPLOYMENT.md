# Deploying Philo

One container, one directory of state, one business. This page covers running
it, putting HTTPS in front of it, backing it up, and upgrading it.

For SMTP setup — the thing that makes notification and acknowledgment email
work — see [EMAIL.md](EMAIL.md).

## What you need

- A host that can run a container (any Linux box, a small VPS is plenty).
- A domain name pointed at it, and TLS. Philo does not terminate TLS itself;
  put a reverse proxy in front. **Web push does not work over plain http** —
  browsers refuse to subscribe outside a secure context — and the session
  cookie is only marked `Secure` when the base URL is `https`.

SQLite means no database server to run, and single-tenancy means no queue,
cache or worker. If you are reaching for more than one container, something has
gone wrong.

## Run it

```bash
docker run -d --name philo --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v philo-data:/data \
  -e PHILO_PUBLIC_BASE_URL=https://philo.example.com \
  -e PHILO_TRUSTED_PROXY=true \
  ghcr.io/philo-crm/philo:edge
```

Then point your reverse proxy at `127.0.0.1:3000` and open
`https://philo.example.com`. The first screen creates the admin account.

Or with Compose:

```yaml
services:
  philo:
    image: ghcr.io/philo-crm/philo:edge
    restart: unless-stopped
    ports:
      - '127.0.0.1:3000:3000'
    volumes:
      - philo-data:/data
    environment:
      PHILO_PUBLIC_BASE_URL: https://philo.example.com
      PHILO_TRUSTED_PROXY: 'true'

volumes:
  philo-data:
```

### Which image tag

| Tag | What it is |
|---|---|
| `edge` | Built from every push to `main`. **The only tag published until the first release.** |
| `0.1.0`, `0.1`, `0` | Published for each tagged release, from most to least specific. |
| `latest` | The newest tagged release. Does not exist until one has been cut. |

Pin `0.1` or `0.1.0` in production once releases exist; `latest` moves under
you, and `edge` moves faster than that.

## Configuration

Only four things are environment variables — what the process must know before
it can serve. Everything else (SMTP, sender identity, business name, funnel
stages, email templates) lives in the database and is edited in the app.

| Variable | Default | What it does |
|---|---|---|
| `PHILO_PORT` | `3000` | Port to listen on. Must be 1–65535, or the process refuses to start. |
| `PHILO_DATA_DIR` | `/data` in the container, `./data` otherwise | Every byte of persistent state. |
| `PHILO_PUBLIC_BASE_URL` | `http://localhost:<port>` | The externally reachable origin. |
| `PHILO_TRUSTED_PROXY` | `false` | Whether to believe `X-Forwarded-For`. Strictly `true`/`1` or `false`/`0` — a typo is a startup error, not a silent "no". |

### `PHILO_PUBLIC_BASE_URL` earns its keep

Every absolute link Philo builds comes from it: the lead links in notification
email, the OAuth issuer and endpoints it advertises to connector clients, the
intake URLs printed at boot. It also decides two things that are easy to get
wrong by omission:

- **`https` marks the session cookie `Secure`.** Leave it unset behind a
  TLS-terminating proxy and the cookie loses `Secure` while everything else
  still looks fine. Philo prints a warning at boot when this happens.
- **`https` is what lets push work at all**, because a browser will not
  subscribe from an insecure context. On an http base URL the Settings toggle
  simply never succeeds, with nothing on screen saying why.

No trailing slash is needed — one is stripped.

### `PHILO_TRUSTED_PROXY` and rate limits

Philo rate-limits login, first-boot setup, and form intake per caller. Behind a
reverse proxy every request arrives from the proxy's address, so without this
setting the whole deployment shares one budget and a single flood spends
everyone's.

Set it to `true` **only when nothing but the proxy can reach the port** — which
is what `-p 127.0.0.1:3000:3000` above buys you. Philo then takes the caller
from `X-Forwarded-For`, reading right to left and stopping at the rightmost
public address, and only when the socket's peer is itself private. An attacker
who pads the header writes entries to the left of what the proxy appended, so
the walk never reaches them; a caller who bypasses the proxy has a public peer
address and is throttled on their own. Every failure direction is
over-restrictive rather than permissive.

## Reverse proxy

### Caddy

```caddyfile
philo.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains and renews the certificate itself, and sets `X-Forwarded-For`
without extra configuration.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name philo.example.com;

    ssl_certificate     /etc/letsencrypt/live/philo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/philo.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`$proxy_add_x_forwarded_for` appends rather than replaces, which is what the
right-to-left walk above expects.

Philo needs nothing else from the proxy: no websocket upgrade, no buffering
tweaks, no path rewriting. Mounting it under a subpath is not supported — give
it a host of its own.

## First run

The boot log is the setup checklist, reprinted every start. Abridged:

```
philo <version> listening on port 3000
  public base url: https://philo.example.com
  data dir:        /data
  database:        /data/philo.db
  intake form:     https://philo.example.com/api/intake/<form_key>
  honeypot field:  _hp (render it hidden; a filled one is filed as spam)
  mcp endpoint:    https://philo.example.com/mcp (authenticate with an API key from Settings)
  ...
```

The lines left out are the ones that only appear when something is unset — no
SMTP configured, an http base URL, no trusted proxy — so read the whole thing
with `docker logs philo`. Then:

1. **Create the admin account.** The first screen at your base URL is a setup
   form; it is reachable without credentials and closes for good at the first
   success. Do this promptly after the instance is publicly reachable — until
   you do, whoever gets there first becomes the admin. If someone beats you to
   it, the fix is to delete the data directory and start again, which costs
   nothing on an instance with no data in it.
2. **Point your website's form at the intake URL** from the log. It accepts
   `application/json` and `application/x-www-form-urlencoded`, so a plain HTML
   form with no JavaScript works. `name` (or `first_name` + `last_name`),
   `email` and `phone` map to columns; every other field is kept as-is. At
   least one of email or phone is required. Add the honeypot field named in the
   log as a hidden input — a submission that fills it is quarantined as spam
   rather than rejected.
3. **Configure SMTP** in Settings — see [EMAIL.md](EMAIL.md). Until you do, no
   notifications and no acknowledgments are sent, and nothing outside the boot
   log says so.
4. **Turn on push**, per device, in Settings. On iOS the site must be added to
   the Home Screen first; the app offers a walkthrough. Push is best-effort by
   design ([ADR-0004](adr/0004-push-best-effort-email-guaranteed.md)) — email
   is the channel that must always work.
5. **Rename the funnel stages** to your own, under Funnel. The seeded
   New → Contacted → Qualified → Closed is a placeholder.

There is no forms UI in the MVP, so the boot log is the only place a form key is
shown. It is an identifier and not a credential — the form that posts to it
lives in a visitor's browser, so it is public by construction. If one leaks to a
spammer, rotating it means changing the row in `intake_forms` and updating the
form.

## What is in the data directory

| File | What it is |
|---|---|
| `philo.db` (plus `-wal`, `-shm`) | Everything: leads, timeline, stages, users, sessions, API keys, settings, email templates. |
| `session-key` | HMAC key signing session cookies. Losing it signs everyone out. |
| `vapid-keys.json` | Web push keypair, generated at first boot. Losing it costs every device its push subscription — each has to re-subscribe. |

**Treat the directory as a secret.** Beyond those two keys, the database holds
your SMTP password in a form that can be read back: SMTP AUTH replays the
credential on every connection, so there is no hashed form that could work.

## Backup

Backup is copying the data directory. The only wrinkle is that SQLite runs in
WAL mode, so a plain `cp` of a live database can capture a torn state.

**Stop, copy, start** — simplest and always correct:

```bash
docker stop philo
docker run --rm -v philo-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/philo-$(date +%F).tar.gz -C /data .
docker start philo
```

**Or take a consistent copy while it runs**, using SQLite's own backup, which
handles the WAL for you. A throwaway container on the same volume opens its own
connection, so the running instance is undisturbed:

```bash
docker run --rm -v philo-data:/data -v "$PWD":/backup alpine sh -c \
  'apk add --no-cache sqlite >/dev/null && \
   sqlite3 /data/philo.db ".backup /backup/philo-$(date +%F).db" && \
   cp /data/session-key /data/vapid-keys.json /backup/'
```

Take the two key files alongside the database, as above, or you will restore a
working CRM that signs everyone out and has lost every push subscription.

Whatever you choose, keep the copies off the host and **test a restore**. An
untested backup is a hypothesis.

## Restore

Set the archive once and **check it before anything destructive runs** — the
step below empties the volume, and the moment you are most likely to run it is
a rehearsal against a volume that still holds your only copy of the data:

```bash
BACKUP=philo-2026-01-31.tar.gz
docker run --rm -v "$PWD":/backup alpine tar tzf "/backup/$BACKUP" | head
```

That should list the database and the two key files — entries carry a `./`
prefix, since the archive was made with `-C /data .`. Then stop the container,
replace the volume's contents, and start it again:

```bash
docker stop philo
docker run --rm -v philo-data:/data -v "$PWD":/backup alpine sh -c "
  test -f '/backup/$BACKUP' &&
  rm -rf /data/* &&
  tar xzf '/backup/$BACKUP' -C /data"
docker start philo
```

The `test -f` is load-bearing, not decoration: `rm -rf /data/*` is the second
command in that chain, and without the guard a `BACKUP` you forgot to set in
this shell empties the volume and *then* discovers there is nothing to extract.

### Restoring the online backup

The `sqlite3 .backup` form produces a standalone `.db` rather than a tarball, so
it goes back a little differently — and **the old `-wal` and `-shm` files have to
go with it.** SQLite would otherwise replay a write-ahead log belonging to a
different database over the one you just restored, which is corruption rather
than an error message:

```bash
BACKUP=philo-2026-01-31.db
docker stop philo
docker run --rm -v philo-data:/data -v "$PWD":/backup alpine sh -c "
  test -f '/backup/$BACKUP' &&
  rm -f /data/philo.db /data/philo.db-wal /data/philo.db-shm &&
  cp '/backup/$BACKUP' /data/philo.db &&
  cp /backup/session-key /backup/vapid-keys.json /data/ &&
  chown -R 1000:1000 /data"
docker start philo
```

The `chown` matters: the container runs as the unprivileged `node` user, and a
file written by a root helper container is not writable by it.

Restoring onto a **newer** Philo is fine — migrations run at startup and bring
the schema forward. Restoring onto an **older** one is not: the database
records migrations it has already applied, and an older binary has no idea what
they were.

## Upgrading

```bash
docker pull ghcr.io/philo-crm/philo:edge
docker stop philo && docker rm philo
# re-run the same `docker run` command
```

Migrations apply automatically at startup, before the server listens — a failed
migration fails the boot rather than surfacing later as a broken write. Back up
first: rolling back means restoring the backup, because there is no down
migration.

## Monitoring

`GET /version` answers `{"name":"philo","version":"..."}` without a credential,
which is what the image's own `HEALTHCHECK` polls. `docker ps` shows the result.
Anything more — uptime checks, log shipping — is ordinary container practice and
Philo has no opinion about it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Login appears to do nothing | `PHILO_PUBLIC_BASE_URL` is `https` but the page is actually being served over http. The cookie is `Secure` exactly when the base URL is `https`, and a browser never returns a `Secure` cookie over http. |
| The push toggle never turns on | Base URL is not `https`, or, on iOS, the site has not been added to the Home Screen. EU iOS has no PWA push at all. |
| No email arrives, no error shown | SMTP is not configured, or a template is disabled. The boot log says which; template edits are in Settings. |
| A legitimate submitter is rate-limited | Behind a proxy without `PHILO_TRUSTED_PROXY=true`, everyone shares one budget. |
| Form posts fail from the browser with a CORS error | The form's origin is not in that intake form's `allowed_origins`. |
| The app loads but every screen 401s | The session expired. Sessions are ~30 days, rolling. |
