# 0004 — Notifications: best-effort declarative web push, email guaranteed

- **Status:** Accepted
- **Date:** 2026-07-28

## Context

"Push to my phone when a lead arrives" is an MVP requirement, and the phone
is an iPhone. Verified state of iOS web push (2026-07): it works **only** for
web apps added to the Home Screen, never in-browser; historically fragile
(service workers killed, subscriptions silently lost), materially improved
by Declarative Web Push (Safari 18.4+, now a multi-vendor W3C draft) which
renders push JSON without a service worker; iOS 26 opens Home-Screen-added
sites as web apps by default; EU iOS has no PWA push at all (DMA). Push
permission requires a user gesture after install. A self-hosted product also
cannot assume any operator setup for push infrastructure.

## Options considered

### Option A — Push as the sole/primary channel

- Pro: matches the headline requirement.
- Con: a silently-dead subscription means a silently-missed lead — the
  worst failure mode this product can have.

### Option B — Native app / APNs

- Con: out of the question for a self-hosted hobby-scale web product.

### Option C — Push as fast path, email as guaranteed path

- Pro: the new-lead notification email is *already* MVP scope, so the
  guaranteed channel costs nothing extra; push failure degrades latency,
  never delivery.
- Con: none meaningful.

## Decision

**Option C**, with this implementation shape:

- Standard Web Push protocol (`web-push` library); **VAPID keys
  auto-generate at first boot** into the data dir — zero operator setup.
- **Payloads in Declarative Web Push JSON format**: iOS 18.4+ renders them
  with no service worker (the reliable path); other browsers fall through to
  a ~20-line service worker parsing the same JSON. One format, both worlds.
- Subscriptions in a `push_subscriptions` table, pruned on 404/410.
- The PWA ships an iOS install-helper screen (Add to Home Screen walkthrough,
  permission prompt from a tap).
- **Trigger: new lead only** — stage moves are made by the person who'd be
  notified.

## Consequences

- A lead is never lost to push flakiness; the email always goes out.
- iOS users must install to Home Screen for push — documented in-app; EU
  iOS limitation is a docs footnote for self-hosters.
- No third channel (ntfy, webhook) in MVP; add only if push+email proves
  insufficient.
- Revisit if: Declarative Web Push adoption shifts, or a real second user
  wants stage-transition notifications (becomes a setting, not a rework).
