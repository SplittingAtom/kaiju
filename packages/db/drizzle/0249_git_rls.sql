-- KOBE-757 (Workspace git GIT-1): team isolation and the SQL-only keys of git_connections and
-- git_repositories (0248). Custom, so db:rebase keeps this SQL as written. The tables are new and
-- empty: nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation: ENABLE + FORCE RLS and the canonical policy on both. No break_glass_read policy:
-- neither holds member content, and the sealed credential must never be readable outside the
-- server's own use. No SECURITY DEFINER function (KOBE-42 rule; the catalog check asserts it).
ALTER TABLE "git_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "git_connections"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "git_repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_repositories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "git_repositories"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Keys inside the Workspace (drizzle cannot express ON DELETE SET NULL (column)): a removed
-- connection, or a deleted project, clears only its own column and the repository's record stays
-- (spec G20: the Repo becomes read-only from its mirror; an admin may relink it). Both keys lead
-- with team_id, so neither can point into another Workspace; git_repositories_host_unique and
-- git_repositories_project_unique cover them.
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_connection_fk"
  FOREIGN KEY ("team_id", "connection_id") REFERENCES "public"."git_connections" ("team_id", "id")
  ON DELETE SET NULL ("connection_id");--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_project_fk"
  FOREIGN KEY ("team_id", "project_id") REFERENCES "public"."projects" ("team_id", "id")
  ON DELETE SET NULL ("project_id");
