-- KOBE-409 (v1.3 Semantic Memory SMD2): optional pgvector embeddings on the three
-- memory item version tables. Custom, so db:rebase keeps this SQL as written. Nothing here is in
-- the drizzle schema: the columns exist only where pgvector does, and the server reads them with
-- raw SQL after detecting them at runtime (FTS-only otherwise, with a Site console notice).
--
-- Must not fail on a Postgres without pgvector (external installs). pgvector is not a trusted
-- extension and the migration role is never a superuser (migrate.ts refuses one), so the
-- extension is created here only when this role may; otherwise a superuser runs
-- `CREATE EXTENSION vector` once (the chart's CloudNativePG bootstrap does it when the image has
-- it) and the next migration run adds the columns: migrate.ts calls kobe_ensure_memory_vectors()
-- after every run. Plain invoker-rights function, never SECURITY DEFINER (KOBE-42); EXECUTE is
-- revoked from PUBLIC, so only the owner (the migration role) runs it.
--
-- Columns: `embedding vector` without a fixed dimension (it follows the Site embedding model:
-- nomic-embed-text 768, qwen3-embedding 1024), `embedding_model` (the gateway model id that made
-- it) and `embedding_dims`. The server ranks only rows whose model is the current Site model, so a
-- model change re-embeds in the background while keyword search covers the rest. No vector index:
-- as with GIN, an index is only worth it where RLS does not defeat it, and per-Workspace candidate
-- sets are small; an ANN index also needs one fixed dimension.
CREATE FUNCTION "public"."kobe_ensure_memory_vectors"() RETURNS boolean
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
      RAISE NOTICE 'pgvector is not available on this Postgres server: memory search stays keyword-only (FTS). Add the pgvector package to the server, run CREATE EXTENSION vector as a superuser, then upgrade Kobe to enable vector search.';
      RETURN false;
    END IF;
    BEGIN
      CREATE EXTENSION vector SCHEMA public;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'pgvector is available but not enabled in this database, and the migration role may not enable it: as a superuser run CREATE EXTENSION vector in this database, then upgrade Kobe to enable vector memory search. Until then memory search stays keyword-only (FTS).';
      RETURN false;
    END;
  END IF;
  FOREACH t IN ARRAY ARRAY['semantic_memory_item_versions', 'portable_memory_item_versions', 'site_memory_item_versions'] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS "embedding" public.vector, '
      'ADD COLUMN IF NOT EXISTS "embedding_model" text, ADD COLUMN IF NOT EXISTS "embedding_dims" integer', t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_embedding'
                   AND conrelid = format('public.%I', t)::regclass) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ('
        '("embedding" IS NULL AND "embedding_model" IS NULL AND "embedding_dims" IS NULL) OR '
        '("embedding" IS NOT NULL AND "embedding_model" IS NOT NULL AND "embedding_dims" IS NOT NULL '
        'AND char_length("embedding_model") BETWEEN 1 AND 200 '
        'AND "embedding_dims" BETWEEN 1 AND 4096 AND public.vector_dims("embedding") = "embedding_dims"))',
        t, t || '_embedding');
    END IF;
  END LOOP;
  RETURN true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."kobe_ensure_memory_vectors"() FROM PUBLIC;--> statement-breakpoint
SELECT "public"."kobe_ensure_memory_vectors"();--> statement-breakpoint

-- Versions stay immutable (0217, 0222) except for the embedding columns: the server writes them
-- after the version is saved (embed on save, backfill, re-embed on a model change). The app role
-- gets UPDATE on those columns only (tenancy/memory.ts columnGrants; RLS still confines Workspace
-- versions). Everything else as in 0222.
CREATE OR REPLACE FUNCTION "public"."semantic_memory_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  scrubbed constant text[] := ARRAY['evidence', 'source_thread_id', 'source_entry_ids', 'statement_tsv'];
  embedded constant text[] := ARRAY['embedding', 'embedding_model', 'embedding_dims', 'statement_tsv'];
  prunable boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    -- Pruning: a non-current version no visible run record uses (the run-record guard below
    -- covers the records this trigger cannot see).
    IF TG_TABLE_NAME = 'semantic_memory_item_versions' THEN
      prunable := EXISTS (
          SELECT 1 FROM "public"."semantic_memory_items" i
          WHERE i.team_id = OLD.team_id AND i.id = OLD.item_id AND i.current_version <> OLD.version)
        AND NOT EXISTS (
          SELECT 1 FROM "public"."run_memory_items" r
          WHERE r.team_id = OLD.team_id AND r.item_id = OLD.item_id AND r.version = OLD.version);
    ELSIF TG_TABLE_NAME = 'portable_memory_item_versions' THEN
      prunable := EXISTS (
          SELECT 1 FROM "public"."portable_memory_items" i
          WHERE i.id = OLD.item_id AND i.current_version <> OLD.version)
        AND NOT EXISTS (
          SELECT 1 FROM "public"."run_portable_memory_items" r
          WHERE r.item_id = OLD.item_id AND r.version = OLD.version);
    ELSIF TG_TABLE_NAME = 'site_memory_item_versions' THEN
      prunable := EXISTS (
          SELECT 1 FROM "public"."site_memory_items" i
          WHERE i.id = OLD.item_id AND i.current_version <> OLD.version)
        AND NOT EXISTS (
          SELECT 1 FROM "public"."run_site_memory_items" r
          WHERE r.item_id = OLD.item_id AND r.version = OLD.version);
    END IF;
    IF prunable THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'only a non-current memory item version no run used can be deleted'
      USING ERRCODE = '55000';
  END IF;
  -- Embedding refresh (KOBE-409), on all three version tables: only the embedding columns change
  -- (statement_tsv: see 0217). It removes nothing, so holds do not refuse it. A team_id change is
  -- not in the list, so it still reaches RLS below.
  IF (to_jsonb(NEW) - embedded) = (to_jsonb(OLD) - embedded) THEN
    RETURN NEW;
  END IF;
  -- Nested: PL/pgSQL may evaluate both operands, and the site-wide versions have no team_id.
  IF TG_TABLE_NAME = 'semantic_memory_item_versions' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - scrubbed) = (to_jsonb(OLD) - scrubbed)
      AND (NEW.evidence IS NULL OR NEW.evidence IS NOT DISTINCT FROM OLD.evidence)
      AND (NEW.source_thread_id IS NULL OR NEW.source_thread_id IS NOT DISTINCT FROM OLD.source_thread_id)
      AND (NEW.source_entry_ids IS NULL OR NEW.source_entry_ids IS NOT DISTINCT FROM OLD.source_entry_ids) THEN
      IF (NEW.evidence, NEW.source_thread_id, NEW.source_entry_ids)
          IS DISTINCT FROM (OLD.evidence, OLD.source_thread_id, OLD.source_entry_ids) THEN
        PERFORM "public"."legal_hold_lock_shared"();
        IF "public"."memory_legal_hold_covers"(NEW.team_id, (
            SELECT i.owner_user_id FROM "public"."semantic_memory_items" i
            WHERE i.team_id = NEW.team_id AND i.id = NEW.item_id)) THEN
          RAISE EXCEPTION 'memory under legal hold cannot be scrubbed' USING ERRCODE = 'KH001';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'memory item versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
--> statement-breakpoint

-- run_usage kind `memory_embed`: the server's embedding calls through the gateway (embed on save,
-- backfill, re-embed, and the per-message query embedding of the selector). A server call (no
-- sandbox); it may name the run whose start needed it (query embedding) or no run at all (saves and
-- background jobs), so the shape takes both. NOT VALID, no VALIDATE, as 0192 and 0229: every
-- existing row passes by construction, and the previous release writes only kinds both CHECKs
-- still accept.
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind" CHECK ("run_usage"."kind" IN ('run', 'title', 'followups', 'eval', 'eval_judge', 'skill_manifest', 'memory_learn', 'memory_embed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind_shape";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind_shape" CHECK (("run_usage"."kind" IN ('run', 'eval') AND "run_usage"."sandbox_id" IS NOT NULL) OR ("run_usage"."kind" = 'skill_manifest' AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NULL) OR ("run_usage"."kind" = 'memory_embed' AND "run_usage"."sandbox_id" IS NULL) OR ("run_usage"."kind" NOT IN ('run', 'eval', 'skill_manifest', 'memory_embed') AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NOT NULL)) NOT VALID;
