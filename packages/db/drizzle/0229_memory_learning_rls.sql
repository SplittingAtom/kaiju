-- KOBE-389 (v1.3 Semantic Memory SMB1): team isolation, the proposals' ref keys and legal-hold
-- guards for the learning tables of 0228. Custom, so db:rebase keeps this SQL as written. The
-- tables are new and empty: nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation: ENABLE + FORCE RLS and the canonical policy on all five, as in
-- 0217_semantic_memory_rls.sql. No break_glass_read policy (as the semantic memory tables: none
-- yet). No SECURITY DEFINER function (KOBE-42 rule; the catalog check asserts it).
ALTER TABLE "memory_learning_passes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_learning_passes"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "memory_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_candidates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_candidates"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "memory_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_dismissals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_dismissals"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "memory_learning_watermarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_learning_watermarks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_learning_watermarks"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "memory_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_proposals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_proposals"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Proposal refs (drizzle cannot express ON DELETE SET NULL (column)): keys into this Workspace's
-- candidates and items. A proposal carries its own statement, kind and rationale, so deleting its
-- source clears only the ref: a purged thread takes its candidates (SM28) and the curator's queue
-- keeps the proposal; a deleted personal item leaves the proposal (or its decided record) behind.
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_candidate_fk"
  FOREIGN KEY ("team_id", "candidate_ref") REFERENCES "public"."memory_candidates" ("team_id", "id")
  ON DELETE SET NULL ("candidate_ref");--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_item_fk"
  FOREIGN KEY ("team_id", "item_ref") REFERENCES "public"."semantic_memory_items" ("team_id", "id")
  ON DELETE SET NULL ("item_ref");--> statement-breakpoint

-- Legal hold (D18). Passes, candidates, dismissals and watermarks are tied to a thread and go with
-- it by cascade; a held thread is never purged (the threads guard refuses), so a cascade from a
-- thread purge needs no second check. Direct deletes (the retention sweeps of KOBE-651) are
-- refused while a hold covers the pass's person (a pass and its candidates) or the proposer (a
-- proposal; it outlives its thread). Rows whose thread or pass is already gone left with that
-- cascade, whose own guard (same statement, same transaction) already decided: skip them.
-- Dismissals (a hash) and watermarks (an entry id) hold no content: no delete guard. TRUNCATE is
-- refused on all five while any hold is active.
CREATE FUNCTION "public"."memory_learning_passes_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id, d.user_id FROM gone d) g
    JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, g.user_id)) THEN
    RAISE EXCEPTION 'learning passes under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_learning_passes_legal_hold" AFTER DELETE ON "memory_learning_passes"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."memory_learning_passes_legal_hold_guard"();--> statement-breakpoint

CREATE FUNCTION "public"."memory_candidates_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.pass_id FROM gone d) g
    JOIN "public"."memory_learning_passes" p ON p.team_id = g.team_id AND p.id = g.pass_id
    WHERE "public"."legal_hold_covers"(g.team_id, p.user_id)) THEN
    RAISE EXCEPTION 'memory candidates under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_candidates_legal_hold" AFTER DELETE ON "memory_candidates"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."memory_candidates_legal_hold_guard"();--> statement-breakpoint

CREATE FUNCTION "public"."memory_proposals_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.proposer_id FROM gone d) g
    WHERE "public"."legal_hold_covers"(g.team_id, g.proposer_id)) THEN
    RAISE EXCEPTION 'memory proposals under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_proposals_legal_hold" AFTER DELETE ON "memory_proposals"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."memory_proposals_legal_hold_guard"();--> statement-breakpoint

CREATE TRIGGER "memory_learning_passes_legal_hold_truncate" BEFORE TRUNCATE ON "memory_learning_passes"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "memory_candidates_legal_hold_truncate" BEFORE TRUNCATE ON "memory_candidates"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "memory_dismissals_legal_hold_truncate" BEFORE TRUNCATE ON "memory_dismissals"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "memory_learning_watermarks_legal_hold_truncate" BEFORE TRUNCATE ON "memory_learning_watermarks"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "memory_proposals_legal_hold_truncate" BEFORE TRUNCATE ON "memory_proposals"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
--> statement-breakpoint

-- run_usage kind `memory_learn` (for KOBE-390): a learning pass's model call, a server call bound
-- to the leaf's last completed run (no sandbox, run_id set, like title/followups/eval_judge). The
-- shape CHECK of 0192 already puts every kind other than run/eval/skill_manifest in that branch,
-- so only the kind list widens. NOT VALID, no VALIDATE, as 0192: every existing row passes by
-- construction, and validating would scan the ledger under the DROP's lock. The previous release
-- writes only the kinds 0192 names, which the CHECK still accepts.
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind" CHECK ("run_usage"."kind" IN ('run', 'title', 'followups', 'eval', 'eval_judge', 'skill_manifest', 'memory_learn')) NOT VALID;
