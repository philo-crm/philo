# Contributing to Philo

Thanks for your interest in contributing.

## Scope

Philo targets **single-business self-hosting** — one business running its own
instance. Multi-tenancy is a permanent non-goal. Contributions that fit that
scope are welcome; features outside it will not be merged into the core.

Philo's recruiting use case is pre-screening only. Anything touching DOT driver
qualification files, FMCSA-mandated employment applications, background checks,
or FCRA-regulated consumer reports is out of scope and will not be merged.

## Developer Certificate of Origin (DCO)

All commits must be signed off. Signing off certifies that you wrote the patch
or otherwise have the right to submit it under the project's license, per the
[Developer Certificate of Origin](https://developercertificate.org/).

Add a sign-off to each commit:

    git commit -s -m "your message"

This appends a trailer to the commit message:

    Signed-off-by: Your Name <your@email>

The name and email must match your commit author identity. A CI check enforces
this on every pull request — commits without a valid sign-off block the merge.
If you forget, amend the most recent commit with:

    git commit --amend -s --no-edit

## Development setup

Node 24 or newer. From the repo root:

    npm install          # install both workspaces
    npm test             # server test suite
    npm run typecheck    # both workspaces
    npm run build        # web -> server/public, then server -> server/dist

Run the server in watch mode with `npm run dev`; for the PWA with hot reload,
run `npm run dev --workspace web` alongside it (Vite proxies `/api` and
`/version` to the server on port 3000).

Configuration is environment-driven: `PHILO_PORT` (default 3000),
`PHILO_DATA_DIR` (default `./data` locally, `/data` in the container), and
`PHILO_PUBLIC_BASE_URL` (default `http://localhost:<port>`).

The container is built from the repo root and keeps all state in one volume:

    docker build -t philo:dev .
    docker run -p 3000:3000 -v philo-data:/data philo:dev

## Architecture decisions

Significant architectural choices are recorded in [docs/adr/](docs/adr/). If
your change contradicts an accepted ADR, open an issue to discuss superseding
it first.

## Pull requests

- Keep each PR focused on one change.
- Use conventional-commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`.
- A PR description should say what changed and how you verified it.
