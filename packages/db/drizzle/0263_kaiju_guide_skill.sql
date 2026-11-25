-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-833 (rename step RN-20, owner decision 2026-11-24, spec rename-kaiju §11 A12): Kaiju's
-- built-in skill `kobe-guide` is published from this release as `kaiju-guide`. Drizzle generated
-- the CHECK statements; the rename between them is hand-written.
--
-- 1. Kaiju's catalog skill `kobe-guide` is renamed `kaiju-guide` in place: the row keeps its id, so
--    every team install (with its pin mode and access), opt-out and block, its tags and Default
--    syncs, a Site admin's draft or detachment, and the old version 1.0.0 (history; its bytes are
--    unchanged) follow it.
--    The server's seed then publishes `kaiju-guide` 1.1.0 into the same skill: installs that track
--    within the major or the latest get it at their next run (the normal version rule); an install
--    a team admin pinned to 1.0.0 stays on it and is offered the update.
-- 2. Only where no other catalog skill already holds `kaiju-guide` (a maintainer may have taken it
--    before this release): there Kaiju's skill keeps `kobe-guide` and its installs, the other skill
--    keeps `kaiju-guide`, and the seed skips Kaiju's new version (logged), as for `kobe-guide` in
--    KOBE-620. A notice says so.
-- 3. The CHECK: both names stay reserved for publisher `kaiju` (the old one only for a skill this
--    migration could not rename), and a non-Kaiju skill may keep either name it held before.
-- 4. No new Kaiju skill takes the old name: a server pod of the previous release still ships the
--    package `kobe-guide` and, finding no skill of that name, would create a second guide skill
--    and install it in every team during the rolling upgrade. Trigger
--    `registry_skills_pre_rename_name` refuses a Kaiju row getting `kobe-guide` (insert or rename;
--    SQLSTATE 23514, invoker rights, pinned search_path, as 0262): that pod's seed fails for the
--    one skill, logged and retried, until it is replaced. The kept row of step 2 is untouched.
--
-- Not rewritten: agents' skill lists (drafts and published, immutable versions) that name
-- `kobe-guide`; the server reads that name as `kaiju-guide` while no catalog skill holds it
-- (`currentSkillNames`). Audit rows and skill eval runs keep the old name (history).
--
-- Migrations run as the owner role. `registry_skills` is site-wide (no RLS): no team is set.
-- (kaiju-guide-skill-upgrade.db.test.ts migrates a populated database.)
ALTER TABLE "registry_skills" DROP CONSTRAINT "registry_skills_kobe_names";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "registry_skills" WHERE "name" = 'kaiju-guide') THEN
    IF EXISTS (SELECT 1 FROM "registry_skills" WHERE "name" = 'kobe-guide' AND "publisher" = 'kaiju') THEN
      RAISE NOTICE 'KOBE-833: another catalog skill holds kaiju-guide; Kaiju''s kobe-guide keeps its name';
    END IF;
  ELSE
    UPDATE "registry_skills" SET "name" = 'kaiju-guide', "updated_at" = now()
     WHERE "name" = 'kobe-guide' AND "publisher" = 'kaiju';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_kobe_names" CHECK (("registry_skills"."publisher" = 'kaiju') = ("registry_skills"."name" IN ('data-analysis', 'charts', 'docx', 'pdf', 'xlsx', 'code-review', 'skill-creator', 'kaiju-guide', 'kobe-guide')) OR ("registry_skills"."publisher" <> 'kaiju' AND "registry_skills"."name" IN ('kobe-guide', 'kaiju-guide')));--> statement-breakpoint
CREATE FUNCTION public.registry_skills_pre_rename_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.publisher::text = 'kaiju' AND NEW.name = 'kobe-guide'
     AND (TG_OP = 'INSERT' OR OLD.name IS DISTINCT FROM NEW.name) THEN
    RAISE EXCEPTION 'kobe-guide was renamed kaiju-guide: Kaiju publishes it under the new name'
      USING ERRCODE = '23514', CONSTRAINT = 'registry_skills_pre_rename_name';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_skills_pre_rename_name" BEFORE INSERT OR UPDATE OF "name" ON "registry_skills"
  FOR EACH ROW EXECUTE FUNCTION public.registry_skills_pre_rename_name();
