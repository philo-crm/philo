-- Multiple funnels — ADR-0009. Hand-edited from the drizzle-kit output, which
-- would add a NOT NULL `pipeline_id` with no default to a table that has rows.
--
-- Funnel-scoped sender settings live on the funnel itself. Empty inherits the
-- instance-wide value.
ALTER TABLE `pipelines` ADD `from_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `reply_to` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pipelines` ADD `notify_recipients` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Every existing form belongs to the one funnel there was. On a fresh database
-- 0002 has already inserted a form and seed.ts has not yet created a funnel, so
-- this leaves it null and the seed assigns it.
ALTER TABLE `intake_forms` ADD `pipeline_id` integer REFERENCES pipelines(id) ON DELETE cascade;--> statement-breakpoint
UPDATE `intake_forms` SET `pipeline_id` = (SELECT `id` FROM `pipelines` ORDER BY `id` LIMIT 1) WHERE `pipeline_id` IS NULL;--> statement-breakpoint
-- Templates go from one per trigger to one per trigger per funnel. A rebuild,
-- because the column is NOT NULL and the old unique index has to go. Existing
-- rows belong to the default funnel; a fresh database has none yet.
CREATE TABLE `__new_email_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pipeline_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_email_templates` (`id`, `pipeline_id`, `trigger`, `subject`, `body`, `enabled`, `updated_at`)
SELECT `id`, (SELECT `id` FROM `pipelines` ORDER BY `id` LIMIT 1), `trigger`, `subject`, `body`, `enabled`, `updated_at`
FROM `email_templates`
WHERE EXISTS (SELECT 1 FROM `pipelines`);--> statement-breakpoint
DROP TABLE `email_templates`;--> statement-breakpoint
ALTER TABLE `__new_email_templates` RENAME TO `email_templates`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_pipeline_trigger_idx` ON `email_templates` (`pipeline_id`,`trigger`);
