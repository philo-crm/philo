ALTER TABLE `users` ADD `role` text;--> statement-breakpoint
ALTER TABLE `users` ADD `role_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_at` integer;--> statement-breakpoint
-- ADR-0012: every account that exists before roles could already do everything.
-- Confirmed now, so an external-IdP account's API keys keep working for the
-- role-confirmation window after the operator turns on the scopes.
UPDATE `users` SET `role` = 'admin', `role_confirmed_at` = CAST(unixepoch('subsec') * 1000 AS integer);
