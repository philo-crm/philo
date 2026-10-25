ALTER TABLE `api_keys` ADD `user_id` integer REFERENCES users(id) ON DELETE cascade;--> statement-breakpoint
-- Keys minted before ADR-0007 belong to the instance's one account.
UPDATE `api_keys` SET `user_id` = (SELECT `id` FROM `users` ORDER BY `id` LIMIT 1) WHERE `user_id` IS NULL;
