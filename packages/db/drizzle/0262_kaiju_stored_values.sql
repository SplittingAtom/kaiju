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
-- 3. Frozen tool manifests of published agent versions (site and team): the tools' `source` and
--    `scope` `kobe` -> `kaiju` (Kaiju's own tools: artifacts, shared files, memory, skills, file
--    edits). Versions are immutable (D19): their triggers are disabled for this one rewrite, and
--    nothing else in a version changes. A manifest that would outgrow its size check keeps its
--    old values; readers map them for good (`withCurrentNames`), as they must for versions an
--    older pod publishes during the rolling upgrade. Orbit evals keep their copy (history; the
--    same reader maps it where an eval still publishes).
-- 4. The gallery agent (owner decision A13): its key `kobe` becomes `kaiju`, and its slug too
--    where no other gallery agent holds `kaiju`. The id, versions, forks (`forked_from_*`),
--    threads, schedules, team defaults and scores keep pointing at it (all by id). Its name and
--    prompt are not touched here: the server's seed publishes the renamed definition (generation
--    5) only where the agent is not customized, so a gallery agent a site admin edited keeps its
--    name and is offered the update. The new CHECK `site_agents_gallery_key_renamed` keeps an
--    older pod's seed from adding a second gallery agent under the old key during the upgrade.
--
-- Kept as they were: audit rows (append-only; the audit views explain old values), run events,
-- thread entries, Orbit eval records (`agent_slug`, manifests) and member content (agents forked
-- from the gallery agent keep their own name and slug).
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS). `team_agent_versions` has FORCE
-- ROW LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for this update only (one
-- transaction; ALTER TABLE holds its lock until commit), as 0235/0258/0260/0261; no team is set.
-- No row is deleted. The helper function exists only inside this transaction.
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
CREATE FUNCTION "public"."kaiju_831_manifest"(m jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN coalesce(jsonb_typeof(m -> 'tools'), '') <> 'array' THEN m ELSE
    jsonb_set(m, '{tools}', (
      SELECT coalesce(jsonb_agg(
               CASE WHEN jsonb_typeof(e) <> 'object' THEN e
                    ELSE e
                      || CASE WHEN e ->> 'source' = 'kobe' THEN '{"source":"kaiju"}'::jsonb
                              ELSE '{}'::jsonb END
                      || CASE WHEN e ->> 'scope' = 'kobe' THEN '{"scope":"kaiju"}'::jsonb
                              ELSE '{}'::jsonb END END
               ORDER BY i), '[]'::jsonb)
        FROM jsonb_array_elements(m -> 'tools') WITH ORDINALITY AS t(e, i))) END
$$;--> statement-breakpoint
ALTER TABLE "team_agent_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" DISABLE TRIGGER "team_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "site_agent_versions" DISABLE TRIGGER "site_agent_versions_immutable";--> statement-breakpoint
UPDATE "site_agent_versions"
   SET "tool_manifest" = "public"."kaiju_831_manifest"("tool_manifest")
   WHERE ("tool_manifest" -> 'tools' @> '[{"source":"kobe"}]'
          OR "tool_manifest" -> 'tools' @> '[{"scope":"kobe"}]')
     AND octet_length("public"."kaiju_831_manifest"("tool_manifest")::text) <= 65536;--> statement-breakpoint
UPDATE "team_agent_versions"
   SET "tool_manifest" = "public"."kaiju_831_manifest"("tool_manifest")
   WHERE ("tool_manifest" -> 'tools' @> '[{"source":"kobe"}]'
          OR "tool_manifest" -> 'tools' @> '[{"scope":"kobe"}]')
     AND octet_length("public"."kaiju_831_manifest"("tool_manifest")::text) <= 65536;--> statement-breakpoint
ALTER TABLE "site_agent_versions" ENABLE TRIGGER "site_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_agent_versions" ENABLE TRIGGER "team_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_agent_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP FUNCTION "public"."kaiju_831_manifest"(jsonb);--> statement-breakpoint
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
