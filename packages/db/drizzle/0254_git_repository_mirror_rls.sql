-- KOBE-766 (Workspace git GIT-10, Repo mirror): team isolation of git_repository_commits (0253).
-- Custom, so db:rebase keeps this SQL as written. The table is new and empty: nothing is
-- backfilled and FORCE RLS needs no lifting.
--
-- Team isolation: ENABLE + FORCE RLS and the canonical policy. No break_glass_read policy: the
-- rows are a cache of the host's commit list (author names and subjects), read only by the server
-- for the Workspace. No SECURITY DEFINER function.
ALTER TABLE "git_repository_commits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_repository_commits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "git_repository_commits"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
