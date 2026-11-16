-- KOBE-652 (v1.3 Semantic Memory SMB14): team isolation, the candidate ref key and legal-hold
-- guards for memory_project_suggestions (0231). Custom, so db:rebase keeps this SQL as written. The
-- table is new and empty: nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation: ENABLE + FORCE RLS and the canonical policy, as the learning tables of
-- 0229_memory_learning_rls.sql. No break_glass_read policy (as the other semantic memory tables:
-- none yet). No SECURITY DEFINER function (KOBE-42 rule; the catalog check asserts it).
ALTER TABLE "memory_project_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_project_suggestions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_project_suggestions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Candidate ref (drizzle cannot express ON DELETE SET NULL (column)): a key into this Workspace's
-- candidates. A suggestion carries its own statement, kind and evidence, so a candidate swept by
-- retention (KOBE-651) clears only the ref and the editors' queue keeps the suggestion.
ALTER TABLE "memory_project_suggestions" ADD CONSTRAINT "memory_project_suggestions_candidate_fk"
  FOREIGN KEY ("team_id", "candidate_ref") REFERENCES "public"."memory_candidates" ("team_id", "id")
  ON DELETE SET NULL ("candidate_ref");--> statement-breakpoint

-- Legal hold (D18). A suggestion goes with its thread by cascade (its quotes come from it, SM28),
-- and with its project, whose threads must go first (threads_project_fk restricts); a held thread
-- is never purged (the threads guard refuses), so a cascade from a thread purge needs no second
-- check. Direct deletes (the retention sweeps of KOBE-651) are refused while a hold covers the
-- suggester, whose words the evidence quotes. Rows whose thread is already gone left with that
-- cascade, whose own guard (same statement, same transaction) already decided: skip them.
-- TRUNCATE is refused while any hold is active.
CREATE FUNCTION "public"."memory_project_suggestions_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id, d.suggested_by FROM gone d) g
    JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, g.suggested_by)) THEN
    RAISE EXCEPTION 'project memory suggestions under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_project_suggestions_legal_hold" AFTER DELETE ON "memory_project_suggestions"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."memory_project_suggestions_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "memory_project_suggestions_legal_hold_truncate" BEFORE TRUNCATE ON "memory_project_suggestions"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
