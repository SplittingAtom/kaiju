-- KOBE-767 review round 2 (R2-L4): backfill git_repositories.linked_at (0257) for Repos linked
-- before it, so the mirror sweep keeps an earlier repository's last mirror (KOBE-766 review M3).
-- Custom, so db:rebase keeps this SQL as written. Migrations run as the owner role (no superuser,
-- no BYPASSRLS) and the tables have FORCE ROW LEVEL SECURITY with no `kobe.team_id` set, so FORCE
-- is lifted for the updates only (one transaction; ALTER TABLE holds its lock until commit), as
-- 0201/0202/0235. Only `linked_at` changes; nothing is deleted.
ALTER TABLE "git_repositories" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_conversions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- A relinked repository (origin 'link'): when its row was last written (its link, or a later
-- relink back to it); never earlier than the link itself.
UPDATE "git_repositories"
   SET "linked_at" = GREATEST("created_at", "updated_at")
 WHERE "linked_at" IS NULL AND "project_id" IS NOT NULL AND "origin" = 'link';--> statement-breakpoint
-- A converted Repo: when its conversion completed.
UPDATE "git_repositories" r
   SET "linked_at" = c."finished_at"
  FROM (SELECT "team_id", "project_id", max("finished_at") AS "finished_at"
          FROM "git_conversions" WHERE "status" = 'completed'
         GROUP BY "team_id", "project_id") c
 WHERE r."linked_at" IS NULL AND r."project_id" IS NOT NULL
   AND c."team_id" = r."team_id" AND c."project_id" = r."project_id";--> statement-breakpoint
ALTER TABLE "git_conversions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_repositories" FORCE ROW LEVEL SECURITY;
