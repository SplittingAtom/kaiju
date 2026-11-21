-- kobe:hand-written
-- kobe:no-transaction
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-735 (review STO-4, STO-15): every foreign key to threads, runs or thread_entries gets an
-- index, so a purge's per-row foreign-key checks and cascades stop scanning the team's rows
-- (catalog.db.test.ts keeps it so). Built CONCURRENTLY outside a transaction (KOBE-734): reads
-- and writes continue while they build; an interrupted build is dropped and rebuilt on the rerun.
-- thread_app_results_thread_idx goes: (team_id, thread_id) is a prefix of both
-- thread_app_results_placed and thread_app_results_entry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "files_run_idx" ON "files" USING btree ("team_id","run_id") WHERE "files"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "artifact_versions_run_idx" ON "artifact_versions" USING btree ("team_id","run_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "approvals_thread_idx" ON "approvals" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "workspace_sync_conflicts_thread_idx" ON "workspace_sync_conflicts" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sandbox_commands_thread_idx" ON "sandbox_commands" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sandbox_run_leases_thread_idx" ON "sandbox_run_leases" USING btree ("team_id","thread_id");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "thread_app_results_thread_idx";
