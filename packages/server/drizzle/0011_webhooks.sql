CREATE TABLE `webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`pipeline_id` integer,
	`events` text DEFAULT '[]' NOT NULL,
	`secret` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_attempt_at` integer,
	`last_status` integer,
	`last_error` text,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
