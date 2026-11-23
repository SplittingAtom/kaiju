-- KOBE-767 (Workspace git GIT-11, committing to a Repo; Repo working copies): team isolation of
-- git_commit_branches and git_working_copies (0253). Custom, so db:rebase keeps this SQL as
-- written. Both tables are new and empty: nothing is backfilled and FORCE RLS needs no lifting.
--
-- ENABLE + FORCE RLS and the canonical policy. No break_glass_read policy: the rows hold a
-- branch name, commit ids, a pull request link and ahead/behind counts of one member's work,
-- read only by the server for the Workspace. No SECURITY DEFINER function.
ALTER TABLE "git_commit_branches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_commit_branches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "git_commit_branches"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "git_working_copies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_working_copies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "git_working_copies"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
