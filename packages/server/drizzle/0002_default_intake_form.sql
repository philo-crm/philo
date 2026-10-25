-- One intake form, so `POST /api/intake/{form_key}` has something to serve on a
-- fresh install. The MVP ships no UI for creating forms, so without this the
-- endpoint is unreachable on every instance.
--
-- A migration rather than seed.ts: seeds run once per database and databases
-- created by the previous schema have already had theirs, so a form added there
-- would never appear on an upgraded install.
--
-- `randomblob` draws from SQLite's CSPRNG, seeded by the VFS from the OS entropy
-- source, so the key is unguessable and different per install — which is all
-- DESIGN.md (Intake endpoint) asks of it, since a form key identifies and never
-- authenticates. Leak it and the operator rotates it.
--
-- `allowed_origins` is `["*"]` because nothing here knows what site the form
-- will live on, and a form that rejects the only origin that posts to it is a
-- broken default. CORS is browser etiquette, not the control keeping spam out —
-- the rate limit and the honeypot are.
INSERT INTO `intake_forms` (`name`, `form_key`, `allowed_origins`, `created_at`)
SELECT
  'Default',
  lower(hex(randomblob(24))),
  '["*"]',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM `intake_forms`);
