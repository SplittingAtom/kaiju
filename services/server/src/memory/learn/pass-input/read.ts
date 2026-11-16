import { sql, type KobeTx } from "@kobe/db";
import type { PathEntry, WatermarkWalk } from "./range.js";
import type { EntryRow } from "./transcript.js";

/**
 * The learning pass's reads of the conversation tree (KOBE-392), in the caller's `withTeam()`
 * transaction. Every query states `team_id` (break-glass rule, parallel-work.md). Only committed
 * entries exist here: an entry still streaming has no row yet (CT4).
 */

/** Most entries walked up a branch (a deeper branch is read from its newest part). */
export const PATH_MAX_ENTRIES = 20_000;

export interface PathRow extends PathEntry {
  readonly type: string;
}

/** The branch from the root to `leaf`, root first (ids, order, type and time only). */
export async function readBranch(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  leaf: string,
): Promise<PathRow[]> {
  const res = await tx.execute<{
    entry_id: string;
    seq: number;
    type: string;
    created_at: Date | string;
  }>(sql`
    WITH RECURSIVE b (entry_id, parent_id, seq, type, created_at, depth) AS (
      SELECT e.entry_id, e.parent_id, e.seq, e.type, e.created_at, 1 FROM thread_entries e
       WHERE e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.entry_id = ${leaf}
      UNION ALL
      SELECT p.entry_id, p.parent_id, p.seq, p.type, p.created_at, b.depth + 1 FROM b
        JOIN thread_entries p ON p.team_id = ${teamId} AND p.thread_id = ${threadId}
                             AND p.entry_id = b.parent_id
       WHERE b.depth < ${PATH_MAX_ENTRIES})
    SELECT entry_id, seq, type, created_at FROM b ORDER BY depth DESC`);
  return res.rows.map((r) => ({
    entryId: r.entry_id,
    seq: Number(r.seq),
    type: r.type,
    createdAt: new Date(r.created_at),
  }));
}

/** `seq` of `entryId` in the thread, or null when it is not there. */
export async function entrySeq(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string,
): Promise<number | null> {
  const res = await tx.execute<{ seq: number }>(sql`
    SELECT seq FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${entryId}`);
  const row = res.rows[0];
  return row ? Number(row.seq) : null;
}

/** The author's watermark on the thread with its ancestors (nearest first), or null. */
export async function readWatermark(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  userId: string,
): Promise<WatermarkWalk | null> {
  const res = await tx.execute<{ entry_id: string; depth: number }>(sql`
    WITH RECURSIVE w (entry_id, parent_id, depth) AS (
      SELECT e.entry_id, e.parent_id, 1 FROM memory_learning_watermarks m
        JOIN thread_entries e ON e.team_id = m.team_id AND e.thread_id = m.thread_id
                             AND e.entry_id = m.entry_id
       WHERE m.team_id = ${teamId} AND m.thread_id = ${threadId} AND m.user_id = ${userId}
      UNION ALL
      SELECT p.entry_id, p.parent_id, w.depth + 1 FROM w
        JOIN thread_entries p ON p.team_id = ${teamId} AND p.thread_id = ${threadId}
                             AND p.entry_id = w.parent_id
       WHERE w.depth < ${PATH_MAX_ENTRIES})
    SELECT entry_id, depth FROM w ORDER BY depth`);
  const [first] = res.rows;
  if (!first) return null;
  return { entryId: first.entry_id, ancestors: res.rows.map((r) => r.entry_id) };
}

/** The bodies of `ids`, at most a few hundred (inline payloads; an offloaded one is flagged). */
export async function readEntries(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  ids: readonly string[],
): Promise<Map<string, EntryRow>> {
  if (ids.length === 0) return new Map();
  const res = await tx.execute<{
    entry_id: string;
    type: string;
    payload: Record<string, unknown> | null;
    offloaded: boolean;
  }>(sql`
    SELECT entry_id, type, payload, blob_ref IS NOT NULL AS offloaded FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId}
       AND entry_id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})`);
  return new Map(
    res.rows.map((r) => [
      r.entry_id,
      { entryId: r.entry_id, type: r.type, payload: r.payload ?? {}, offloaded: r.offloaded },
    ]),
  );
}
