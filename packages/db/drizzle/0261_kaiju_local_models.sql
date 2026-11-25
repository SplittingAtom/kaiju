-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-828 (rename step RN-15, owner decision 2026-11-24, spec rename-kaiju §11 A5): the chart's
-- in-cluster model provider (Site provider id `local`) is the gateway provider `kaiju-local` now,
-- so its models are `kaiju-local/<model>` instead of `kobe-local/<model>`. Catalog entries, agent
-- pins, team defaults, budgets and limits name catalog aliases or provider ids, never the gateway
-- id, so they follow by themselves (`gatewayProviderName`). The stored gateway ids are rewritten:
--
-- 1. The Site embedding model (`site_settings` `memory.settings`, field `embedding_model`).
-- 2. The vectors' `embedding_model` on the three memory version tables (`kobe-local/x#d2` →
--    `kaiju-local/x#d2`), where pgvector added the columns (0230). Only the id changes: the
--    vectors are kept, nothing is re-embedded. The versions' immutability trigger lets the
--    embedding columns change (0230), and it removes nothing, so legal holds do not refuse it.
-- 3. Orbit evals still to run (`pending`, `running`): `model` and the model in their definition,
--    which their Job sends to the gateway.
--
-- Kept as written (history): `run_usage` (append-only; reports map the old id at read time,
-- `currentModelSql`), finished Orbit evals, audit rows, run events and thread entries. The model
-- gateway reads a pre-rename id as the current one, and the gateway sync keeps the old provider
-- name in Bifrost for one release, so a pod or sandbox of the previous release still works during
-- the upgrade.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and the team tables have FORCE
-- ROW LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for these updates only (one
-- transaction; ALTER TABLE holds its lock until commit), as 0235/0258/0260; no team is set. No
-- row is deleted. (kaiju-local-models-upgrade.db.test.ts migrates a populated database.)
UPDATE "site_settings"
   SET "value" = jsonb_set("value"::jsonb, '{embedding_model}',
                           to_jsonb('kaiju-local/' || substr("value"::jsonb ->> 'embedding_model', 12)))::text,
       "updated_at" = now()
 WHERE "key" = 'memory.settings'
   AND CASE WHEN "value" IS NOT NULL AND pg_input_is_valid("value", 'jsonb')
            THEN jsonb_typeof("value"::jsonb) = 'object'
                 AND coalesce(starts_with("value"::jsonb ->> 'embedding_model', 'kobe-local/'), false)
            ELSE false END;--> statement-breakpoint
ALTER TABLE "semantic_memory_item_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orbit_evals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['semantic_memory_item_versions', 'portable_memory_item_versions',
                           'site_memory_item_versions'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = t AND column_name = 'embedding_model') THEN
      EXECUTE format(
        'UPDATE public.%I SET embedding_model = ''kaiju-local/'' || substr(embedding_model, 12) '
        'WHERE starts_with(embedding_model, ''kobe-local/'')', t);
    END IF;
  END LOOP;
END;
$$;--> statement-breakpoint
UPDATE "orbit_evals"
   SET "model" = 'kaiju-local/' || substr("model", 12)
 WHERE "status" IN ('pending', 'running') AND starts_with("model", 'kobe-local/');--> statement-breakpoint
UPDATE "orbit_evals"
   SET "definition" = jsonb_set("definition", '{frontmatter,model}',
                                to_jsonb('kaiju-local/' || substr("definition" #>> '{frontmatter,model}', 12)))
 WHERE "status" IN ('pending', 'running')
   AND jsonb_typeof("definition" -> 'frontmatter') = 'object'
   AND starts_with("definition" #>> '{frontmatter,model}', 'kobe-local/');--> statement-breakpoint
ALTER TABLE "orbit_evals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "semantic_memory_item_versions" FORCE ROW LEVEL SECURITY;
