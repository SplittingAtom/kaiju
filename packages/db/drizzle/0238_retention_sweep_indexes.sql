-- kobe:no-transaction
-- KOBE-741 (review STO-10): the nightly table sweeps find old rows through these partial indexes
-- instead of scanning a team's events or notifications. SQL-only (not in the drizzle schema, like
-- events_schedule_latest_idx). Built CONCURRENTLY outside a transaction (KOBE-734): reads and
-- writes continue while they build; an interrupted build is dropped and rebuilt on the rerun.
-- events: processed or failed events oldest first (pending and scheduled ones have their own).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_retention_idx" ON "events" USING btree ("team_id", "created_at") WHERE "status" IN ('processed', 'failed');--> statement-breakpoint
-- notifications: read notifications by when they were read.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_read_idx" ON "notifications" USING btree ("team_id", "read_at") WHERE "read_at" IS NOT NULL;
