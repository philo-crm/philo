-- A deleted lead must not stay readable in the search index — DESIGN.md
-- (Erasure). By default FTS5 deletes by appending a marker, and the tokens it
-- cancels stay in older index segments until a merge happens to reach them;
-- `PRAGMA secure_delete` cannot help, because those pages are never freed.
-- This option makes FTS5 remove them in place. It is stored in
-- `leads_fts_config`, so a migration that rebuilds `leads_fts` must set it again.
INSERT INTO `leads_fts` (`leads_fts`, `rank`) VALUES ('secure-delete', 1);
--> statement-breakpoint
-- Merges the existing segments into one, dropping whatever earlier edits had
-- only marked as deleted.
INSERT INTO `leads_fts` (`leads_fts`) VALUES ('optimize');
