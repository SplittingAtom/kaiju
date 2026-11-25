-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-831 (rename step RN-18, owner decision 2026-11-24, spec rename-kaiju §11 A8 and A13): the
-- value `kobe` stored in enums and rows becomes `kaiju`. Drizzle generated the CHECK statements
-- (it would recreate the enum type, which fails on existing rows: replaced by RENAME VALUE);
-- everything between the drops and the adds is hand-written.
--
-- 1. The registry publisher: `ALTER TYPE ... RENAME VALUE` keeps every row (skills and versions)
--    valid in place, with no rewrite and no trigger; the CHECKs that name the value are dropped
--    and added again with `kaiju` (`registry_versions_approval` compares the value as text).
-- 2. Kaiju-published versions' stored provenance: `publisher` and the scanner name
--    (`kobe-skill-scanner` -> `kaiju-skill-scanner`). A catalog version's provenance is immutable
--    (0133): its trigger is disabled for this one rewrite only, inside this transaction, and
--    nothing else changes (the package bytes and hashes do not hold the provenance; exports write
--    provenance.json from this column).
-- 3. Not rewritten (coordinator decision, KOBE-831): the frozen tool manifests of published agent
--    versions keep their tools' `source`/`scope` `kobe`. Members never see the value; the server
--    of this release maps it to `kaiju` whenever it reads a manifest (`withCurrentNames`, for
--    good), while pods of the previous release keep reading the unchanged rows during the
--    rolling upgrade (a rewrite would fail every run on a published agent there).
-- 4. The gallery agent (owner decision A13): its key `kobe` becomes `kaiju`, and its slug too
--    where no other gallery agent holds `kaiju`. The id, versions, forks (`forked_from_*`),
--    threads, schedules, team defaults and scores keep pointing at it (all by id). Its name and
--    prompt are not touched here: the server's seed publishes the renamed definition (generation
--    5) only where the agent is not customized, so a gallery agent a site admin edited keeps its
--    name and is offered the update. The new CHECK `site_agents_gallery_key_renamed` keeps an
--    older pod's seed from adding a second gallery agent under the old key during the upgrade.
--
-- Kept as they were: audit rows (append-only; the audit views explain old values), run events,
-- thread entries, agent versions and Orbit eval records (`agent_slug`, manifests) and member
-- content (agents forked from the gallery agent keep their own name and slug).
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS). Every table touched here is
-- site-wide (no RLS), so no team is set and no FORCE is lifted. No row is deleted.
-- (kaiju-stored-values-upgrade.db.test.ts migrates a populated database.)
ALTER TABLE "registry_skills" DROP CONSTRAINT "registry_skills_kobe_names";--> statement-breakpoint
ALTER TABLE "registry_skills" DROP CONSTRAINT "registry_skills_detached";--> statement-breakpoint
ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_kobe_publisher";--> statement-breakpoint
ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_approval";--> statement-breakpoint
ALTER TYPE "public"."registry_publisher" RENAME VALUE 'kobe' TO 'kaiju';--> statement-breakpoint
ALTER TABLE "registry_versions" DISABLE TRIGGER "registry_versions_immutable";--> statement-breakpoint
UPDATE "registry_versions"
   SET "provenance" = jsonb_set("provenance", '{publisher}', '"kaiju"')
   WHERE "provenance" ->> 'publisher' = 'kobe';--> statement-breakpoint
UPDATE "registry_versions"
   SET "provenance" = jsonb_set("provenance", '{scan,scanner,name}', '"kaiju-skill-scanner"')
   WHERE "provenance" #>> '{scan,scanner,name}' = 'kobe-skill-scanner';--> statement-breakpoint
ALTER TABLE "registry_versions" ENABLE TRIGGER "registry_versions_immutable";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM site_agents WHERE gallery_key = 'kobe')
     AND EXISTS (SELECT 1 FROM site_agents WHERE gallery_key = 'kaiju') THEN
    -- No release ever seeded the key `kaiju` before this one: two rows mean a hand-made state.
    RAISE EXCEPTION 'KOBE-831: site_agents holds gallery keys kobe and kaiju; archive or remove one first';
  END IF;
  IF EXISTS (SELECT 1 FROM site_agents WHERE gallery_key = 'kobe' AND slug = 'kobe')
     AND EXISTS (SELECT 1 FROM site_agents WHERE scope = 'gallery' AND slug = 'kaiju') THEN
    RAISE NOTICE 'KOBE-831: the gallery agent keeps its slug kobe (another gallery agent holds kaiju)';
  END IF;
  UPDATE site_agents
     SET gallery_key = 'kaiju',
         slug = CASE WHEN slug = 'kobe'
                      AND NOT EXISTS (SELECT 1 FROM site_agents o
                                       WHERE o.scope = 'gallery' AND o.slug = 'kaiju')
                     THEN 'kaiju' ELSE slug END
   WHERE gallery_key = 'kobe';
END
$$;--> statement-breakpoint
ALTER TABLE "site_agents" ADD CONSTRAINT "site_agents_gallery_key_renamed" CHECK ("site_agents"."gallery_key" <> 'kobe');--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_kobe_names" CHECK (("registry_skills"."publisher" = 'kaiju') = ("registry_skills"."name" IN ('data-analysis', 'charts', 'docx', 'pdf', 'xlsx', 'code-review', 'skill-creator', 'kobe-guide')) OR ("registry_skills"."publisher" <> 'kaiju' AND "registry_skills"."name" IN ('kobe-guide')));--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_detached" CHECK (("registry_skills"."detached_at" IS NULL AND "registry_skills"."detached_by" IS NULL AND "registry_skills"."detached_from_version" IS NULL AND "registry_skills"."kobe_shipped_version" IS NULL)
        OR ("registry_skills"."detached_at" IS NOT NULL AND "registry_skills"."detached_by" IS NOT NULL
          AND "registry_skills"."detached_from_version" IS NOT NULL AND "registry_skills"."detached_from_version" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
          AND ("registry_skills"."kobe_shipped_version" IS NULL OR "registry_skills"."kobe_shipped_version" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$')
          AND "registry_skills"."publisher" = 'kaiju'));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_kobe_publisher" CHECK (("registry_versions"."publisher" = 'kaiju') = ("registry_versions"."submitted_by" IS NULL)
        AND ("registry_versions"."publisher" <> 'kaiju' OR ("registry_versions"."reviewed_by" IS NULL AND "registry_versions"."claimed_by" IS NULL
          AND NOT "registry_versions"."self_approved" AND "registry_versions"."runtime_storage_key" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_approval" CHECK (("registry_versions"."state" IN ('approved', 'deprecated', 'withdrawn', 'revoked'))
        = ("registry_versions"."approved_at" IS NOT NULL AND ("registry_versions"."reviewed_by" IS NOT NULL OR "registry_versions"."publisher"::text IN ('kaiju', 'site'))));
