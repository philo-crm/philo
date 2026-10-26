CREATE TABLE `lead_attachment_blobs` (
	`attachment_id` integer PRIMARY KEY NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `lead_attachments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `lead_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lead_id` integer NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lead_attachments_lead_idx` ON `lead_attachments` (`lead_id`);--> statement-breakpoint
-- Hand-edited: drizzle-kit wanted to rebuild `leads` for the new CHECK, and its
-- copy selected `details` from the old table, which has no such column. A
-- rebuild would also drop the FTS triggers. SQLite can add a column with a
-- CHECK in place, so it does.
ALTER TABLE `leads` ADD `details` text DEFAULT '{}' NOT NULL CONSTRAINT "leads_details_json" CHECK(json_valid("details"));
