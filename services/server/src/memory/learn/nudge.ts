import { sql, type KaijuTx } from "@kaiju/db";
import { LEARN_NUDGE_MESSAGES, type LearnState } from "@kaiju/protocol";
import type { Viewer } from "../../threads/repository.js";
import { PATH_MAX_ENTRIES } from "./pass-input/read.js";

/**
 * The Learn nudge (KOBE-410; SM17, Q8): when the + button's dot should pulse once. Two signals,
 * both counted on the visible branch after the person's last pass (their watermark, or the fork
 * point, or the start), the same range `/learn` reads:
 *
 * - `messages`: at least {@link LEARN_NUDGE_MESSAGES} of the person's messages;
 * - `correction`: they thumbed an answer down (KOBE-275 answer feedback) since the pass, or edited
 *   one of their messages (a user message beside an earlier one with different text; a regenerate
 *   or Retry sends the same text again, so it is not a correction).
 *
 * Deterministic and cheap (one read, no model, no text patterns). The nudge never starts a pass.
 */

export type LearnNudge = NonNullable<LearnState["nudge"]>;

export interface NudgeSignals {
  /** The person's watermark entry, or null before their first pass here. */
  readonly mark: string | null;
  readonly messages: number;
  readonly edited: boolean;
  readonly thumbsDown: boolean;
}

/** The nudge for the signals (pure): a correction first, then the message count. */
export function nudgeOf(signals: NudgeSignals): LearnNudge | null {
  const from = signals.mark ?? "start";
  if (signals.edited || signals.thumbsDown)
    return { reason: "correction", key: `${from}:correction` };
  if (signals.messages >= LEARN_NUDGE_MESSAGES)
    return { reason: "messages", key: `${from}:messages` };
  return null;
}

const USER_MESSAGE = (alias: string) =>
  sql.raw(`${alias}.type = 'message' AND ${alias}.payload -> 'message' ->> 'role' = 'user'`);

/** The signals for the person's thread in one read (every query states `team_id`). */
export async function readNudgeSignals(
  tx: KaijuTx,
  viewer: Viewer,
  thread: {
    readonly id: string;
    readonly leafEntryId: string;
    readonly forkedAtEntryId: string | null;
  },
): Promise<NudgeSignals> {
  const { teamId, userId } = viewer;
  const threadId = thread.id;
  const res = await tx.execute<{
    mark: string | null;
    messages: string | number;
    edited: boolean | null;
    thumbs_down: boolean;
  }>(sql`
    WITH RECURSIVE
    w AS (
      SELECT entry_id, updated_at FROM memory_learning_watermarks
       WHERE team_id = ${teamId} AND thread_id = ${threadId} AND user_id = ${userId}),
    wa (entry_id, parent_id, depth) AS (
      SELECT e.entry_id, e.parent_id, 1 FROM w
        JOIN thread_entries e ON e.team_id = ${teamId} AND e.thread_id = ${threadId}
                             AND e.entry_id = w.entry_id
      UNION ALL
      SELECT p.entry_id, p.parent_id, wa.depth + 1 FROM wa
        JOIN thread_entries p ON p.team_id = ${teamId} AND p.thread_id = ${threadId}
                             AND p.entry_id = wa.parent_id
       WHERE wa.depth < ${PATH_MAX_ENTRIES}),
    b (entry_id, parent_id, seq, type, payload, depth) AS (
      SELECT e.entry_id, e.parent_id, e.seq, e.type, e.payload, 1 FROM thread_entries e
       WHERE e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.entry_id = ${thread.leafEntryId}
         AND e.entry_id IS DISTINCT FROM ${thread.forkedAtEntryId}
         AND e.entry_id NOT IN (SELECT entry_id FROM wa)
      UNION ALL
      SELECT p.entry_id, p.parent_id, p.seq, p.type, p.payload, b.depth + 1 FROM b
        JOIN thread_entries p ON p.team_id = ${teamId} AND p.thread_id = ${threadId}
                             AND p.entry_id = b.parent_id
       WHERE b.depth < ${PATH_MAX_ENTRIES}
         AND p.entry_id IS DISTINCT FROM ${thread.forkedAtEntryId}
         AND p.entry_id NOT IN (SELECT entry_id FROM wa))
    SELECT (SELECT entry_id FROM w) AS mark,
           count(*) FILTER (WHERE ${USER_MESSAGE("b")}) AS messages,
           bool_or(${USER_MESSAGE("b")} AND EXISTS (
             SELECT 1 FROM thread_entries s
              WHERE s.team_id = ${teamId} AND s.thread_id = ${threadId}
                AND s.parent_id IS NOT DISTINCT FROM b.parent_id AND s.seq < b.seq
                AND ${USER_MESSAGE("s")}
                AND s.payload -> 'message' -> 'content' IS DISTINCT FROM b.payload -> 'message' -> 'content'
           )) AS edited,
           EXISTS (
             SELECT 1 FROM answer_feedback f
              WHERE f.team_id = ${teamId} AND f.thread_id = ${threadId} AND f.user_id = ${userId}
                AND f.rating = 'down'
                AND f.updated_at > coalesce((SELECT updated_at FROM w), '-infinity'::timestamptz)
           ) AS thumbs_down
      FROM b`);
  const row = res.rows[0];
  return {
    mark: row?.mark ?? null,
    messages: Number(row?.messages ?? 0),
    edited: row?.edited === true,
    thumbsDown: row?.thumbs_down === true,
  };
}
