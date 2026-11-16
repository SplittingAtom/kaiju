import { MEMORY_PASS_MAX_MS } from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";

/**
 * The learning pass's rows (KOBE-393; `memory_learning_passes`, `memory_learning_watermarks`), in
 * the caller's `withTeam()` transaction. Every query states `team_id`.
 *
 * One queued or running pass per thread is the database's rule (the KOBE-389 partial unique
 * index `memory_learning_passes_active_unique`), so a second pass started on another replica is
 * refused there: {@link insertRunningPass} answers null. A pass cannot run longer than
 * `MEMORY_PASS_MAX_MS` (its events are refused after that), so a `running` row older than that
 * belongs to a server that stopped mid-pass: {@link failStalePasses} marks it failed (Retry).
 */

/** Passes one person may start in one Workspace per rolling day (SM14). */
export const LEARN_PASSES_PER_DAY = 20;

const STALE_SECONDS = MEMORY_PASS_MAX_MS / 1000;
export const STALE_PASS_ERROR = "interrupted: the server stopped during the pass; try again";

export interface NewPass {
  readonly teamId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly leafEntryId: string;
  readonly fromEntryId: string;
  readonly modelAlias: string;
  readonly promptVersion: string;
}

/** Inserts the pass as `running`; null when the thread already has an active pass. */
export async function insertRunningPass(tx: KobeTx, p: NewPass): Promise<string | null> {
  const res = await tx.execute<{ id: string }>(sql`
    INSERT INTO memory_learning_passes
      (team_id, thread_id, user_id, branch_leaf_entry_id, from_entry_id, model_alias,
       prompt_version, status, started_at)
    VALUES (${p.teamId}, ${p.threadId}, ${p.userId}, ${p.leafEntryId}, ${p.fromEntryId},
            ${p.modelAlias}, ${p.promptVersion}, 'running', now())
    ON CONFLICT DO NOTHING
    RETURNING id`);
  return res.rows[0]?.id ?? null;
}

/** Passes the person started in this Workspace in the last 24 hours (any outcome). */
export async function passesToday(tx: KobeTx, teamId: string, userId: string): Promise<number> {
  const res = await tx.execute<{ n: string | number }>(sql`
    SELECT count(*) AS n FROM memory_learning_passes
     WHERE team_id = ${teamId} AND user_id = ${userId}
       AND created_at > now() - interval '1 day'`);
  return Number(res.rows[0]?.n ?? 0);
}

/** Marks running passes past `MEMORY_PASS_MAX_MS` failed (one thread, or the whole Workspace). */
export async function failStalePasses(
  tx: KobeTx,
  teamId: string,
  threadId?: string,
): Promise<number> {
  const res = await tx.execute(sql`
    UPDATE memory_learning_passes
       SET status = 'failed', error = ${STALE_PASS_ERROR}, finished_at = now()
     WHERE team_id = ${teamId} AND status IN ('queued', 'running')
       ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`}
       AND coalesce(started_at, created_at) < now() - make_interval(secs => ${STALE_SECONDS})`);
  return res.rowCount ?? 0;
}

/**
 * The run a pass's server-call token is bound to (KOBE-391 note): the newest completed run whose
 * prompt is on the branch root → `leaf`, leased to the author (the gateway checks the lease and
 * the run's status, not that it is on the visible branch: that check is here). Null when none.
 */
export async function leafPathRun(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  leaf: string,
  userId: string,
): Promise<string | null> {
  const res = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE b (entry_id, parent_id, depth) AS (
      SELECT e.entry_id, e.parent_id, 1 FROM thread_entries e
       WHERE e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.entry_id = ${leaf}
      UNION ALL
      SELECT p.entry_id, p.parent_id, b.depth + 1 FROM b
        JOIN thread_entries p ON p.team_id = ${teamId} AND p.thread_id = ${threadId}
                             AND p.entry_id = b.parent_id
       WHERE b.depth < 20000)
    SELECT r.id FROM b
      JOIN runs r ON r.team_id = ${teamId} AND r.thread_id = ${threadId}
                 AND r.user_entry_id = b.entry_id AND r.status = 'completed'
      JOIN sandbox_run_leases l ON l.team_id = r.team_id AND l.run_id = r.id
                               AND l.user_id = ${userId}
     ORDER BY b.depth, r.ended_at DESC NULLS LAST
     LIMIT 1`);
  return res.rows[0]?.id ?? null;
}

export interface PassEnd {
  readonly teamId: string;
  readonly passId: string;
  readonly usage: Record<string, unknown>;
}

/** Completes a running pass at `toEntryId`; false when it is no longer running. */
export async function completePass(
  tx: KobeTx,
  end: PassEnd & { readonly toEntryId: string },
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE memory_learning_passes
       SET status = 'completed', to_entry_id = ${end.toEntryId}, finished_at = now(),
           usage = ${JSON.stringify(end.usage)}::jsonb
     WHERE team_id = ${end.teamId} AND id = ${end.passId} AND status = 'running'`);
  return (res.rowCount ?? 0) === 1;
}

/** Fails a running pass with a short code and message (never model output). */
export async function failPass(
  tx: KobeTx,
  end: PassEnd & { readonly error: string },
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE memory_learning_passes
       SET status = 'failed', error = ${end.error.slice(0, 2000)}, finished_at = now(),
           usage = ${JSON.stringify(end.usage)}::jsonb
     WHERE team_id = ${end.teamId} AND id = ${end.passId} AND status = 'running'`);
  return (res.rowCount ?? 0) === 1;
}

/** The person's watermark in the thread moves to the leaf the pass learned (success only). */
export async function moveWatermark(
  tx: KobeTx,
  w: { teamId: string; threadId: string; userId: string; entryId: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id, updated_at)
    VALUES (${w.teamId}, ${w.threadId}, ${w.userId}, ${w.entryId}, now())
    ON CONFLICT (team_id, thread_id, user_id)
      DO UPDATE SET entry_id = EXCLUDED.entry_id, updated_at = EXCLUDED.updated_at`);
}
