-- KOBE-765 (Workspace git GIT-9, Convert to repo): team isolation and the SQL-only keys of
-- git_conversions (0251). Custom, so db:rebase keeps this SQL as written. The table is new and
-- empty: nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation: ENABLE + FORCE RLS and the canonical policy. No break_glass_read policy: an
-- attempt holds ids, codes and the frozen commit plan (authors and messages of the project's
-- commits), read only by the server for the Workspace. No SECURITY DEFINER function.
ALTER TABLE "git_conversions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_conversions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "git_conversions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Keys inside the Workspace that clear only their own column (drizzle cannot express ON DELETE
-- SET NULL (column) on a key that includes the NOT NULL team_id): a removed connection leaves the
-- attempt (and the snapshot of the host it names); the repository row is never deleted on its own.
-- git_conversions_connection_idx and git_conversions_repository_idx cover them.
ALTER TABLE "git_conversions" ADD CONSTRAINT "git_conversions_connection_fk"
  FOREIGN KEY ("team_id", "connection_id") REFERENCES "public"."git_connections" ("team_id", "id")
  ON DELETE SET NULL ("connection_id");--> statement-breakpoint
ALTER TABLE "git_conversions" ADD CONSTRAINT "git_conversions_repository_fk"
  FOREIGN KEY ("team_id", "repository_id") REFERENCES "public"."git_repositories" ("team_id", "id")
  ON DELETE SET NULL ("repository_id");
