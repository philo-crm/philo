ALTER TABLE `users` ADD `external_subject` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_subject_unique` ON `users` (`external_subject`);