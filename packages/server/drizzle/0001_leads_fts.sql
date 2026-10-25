-- Full-text search over lead text. FTS5 virtual tables cannot be expressed in
-- the Drizzle schema, so this migration is hand-written and drizzle-kit will
-- not diff it — `leads_fts` and its triggers only ever change here.
--
-- `leads_fts.rowid` mirrors `leads.id`, which is an INTEGER PRIMARY KEY and so
-- is stable across VACUUM. Query by joining on it:
--   SELECT l.* FROM leads_fts JOIN leads l ON l.id = leads_fts.rowid
--   WHERE leads_fts MATCH ?;
CREATE VIRTUAL TABLE `leads_fts` USING fts5(`name`, `email`, `phone`, `fields`);
--> statement-breakpoint
-- The `fields` column is indexed as its JSON scalar values only, at any depth.
-- Indexing the raw JSON would make every key ("years_experience") a search term
-- matching every lead that has it; `json_each` would do the same for the keys of
-- a nested object, so the walk is `json_tree` with the containers filtered out.
CREATE TRIGGER `leads_fts_insert` AFTER INSERT ON `leads` BEGIN
  INSERT INTO `leads_fts` (`rowid`, `name`, `email`, `phone`, `fields`)
  VALUES (
    new.`id`,
    new.`name`,
    new.`email`,
    new.`phone`,
    (SELECT group_concat(value, ' ') FROM json_tree(new.`fields`) WHERE type NOT IN ('object', 'array'))
  );
END;
--> statement-breakpoint
CREATE TRIGGER `leads_fts_delete` AFTER DELETE ON `leads` BEGIN
  DELETE FROM `leads_fts` WHERE `rowid` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `leads_fts_update` AFTER UPDATE ON `leads` BEGIN
  DELETE FROM `leads_fts` WHERE `rowid` = old.`id`;
  INSERT INTO `leads_fts` (`rowid`, `name`, `email`, `phone`, `fields`)
  VALUES (
    new.`id`,
    new.`name`,
    new.`email`,
    new.`phone`,
    (SELECT group_concat(value, ' ') FROM json_tree(new.`fields`) WHERE type NOT IN ('object', 'array'))
  );
END;
--> statement-breakpoint
-- Triggers only cover writes from here on; leads that predate this migration
-- would be invisible to search without a backfill.
INSERT INTO `leads_fts` (`rowid`, `name`, `email`, `phone`, `fields`)
SELECT
  `id`,
  `name`,
  `email`,
  `phone`,
  (SELECT group_concat(value, ' ') FROM json_tree(`leads`.`fields`) WHERE type NOT IN ('object', 'array'))
FROM `leads`;
