-- Search covers `details` as well as `fields` — ADR-0008. An FTS5 table cannot
-- gain a column, so the index and its triggers are rebuilt from scratch; the
-- shape of each is the one 0001_leads_fts.sql explains, with `details` walked
-- the same way `fields` is.
DROP TRIGGER `leads_fts_insert`;
--> statement-breakpoint
DROP TRIGGER `leads_fts_delete`;
--> statement-breakpoint
DROP TRIGGER `leads_fts_update`;
--> statement-breakpoint
DROP TABLE `leads_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `leads_fts` USING fts5(`name`, `email`, `phone`, `fields`, `details`);
--> statement-breakpoint
CREATE TRIGGER `leads_fts_insert` AFTER INSERT ON `leads` BEGIN
  INSERT INTO `leads_fts` (`rowid`, `name`, `email`, `phone`, `fields`, `details`)
  VALUES (
    new.`id`,
    new.`name`,
    new.`email`,
    new.`phone`,
    (SELECT group_concat(value, ' ') FROM json_tree(new.`fields`) WHERE type NOT IN ('object', 'array')),
    (SELECT group_concat(value, ' ') FROM json_tree(new.`details`) WHERE type NOT IN ('object', 'array'))
  );
END;
--> statement-breakpoint
CREATE TRIGGER `leads_fts_delete` AFTER DELETE ON `leads` BEGIN
  DELETE FROM `leads_fts` WHERE `rowid` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `leads_fts_update` AFTER UPDATE ON `leads` BEGIN
  DELETE FROM `leads_fts` WHERE `rowid` = old.`id`;
  INSERT INTO `leads_fts` (`rowid`, `name`, `email`, `phone`, `fields`, `details`)
  VALUES (
    new.`id`,
    new.`name`,
    new.`email`,
    new.`phone`,
    (SELECT group_concat(value, ' ') FROM json_tree(new.`fields`) WHERE type NOT IN ('object', 'array')),
    (SELECT group_concat(value, ' ') FROM json_tree(new.`details`) WHERE type NOT IN ('object', 'array'))
  );
END;
--> statement-breakpoint
INSERT INTO `leads_fts` (`rowid`, `name`, `email`, `phone`, `fields`, `details`)
SELECT
  `id`,
  `name`,
  `email`,
  `phone`,
  (SELECT group_concat(value, ' ') FROM json_tree(`leads`.`fields`) WHERE type NOT IN ('object', 'array')),
  (SELECT group_concat(value, ' ') FROM json_tree(`leads`.`details`) WHERE type NOT IN ('object', 'array'))
FROM `leads`;
