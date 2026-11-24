import { sql, type KaijuTx } from "@kaiju/db";
import {
  notifyMemory,
  registerMemoryReminder,
  settleMemoryReminders,
} from "../../notifications/memory.js";

/**
 * To review's notices (KOBE-396 on KOBE-645's machinery). A pass that leaves candidates tells its
 * person in the bell (`memory.review.candidates_ready`, the thread and how many) and owes them one
 * reminder after 7 days (`memory.review.reminder` about the pass); the reminder is settled once
 * none of the pass's candidates is open. When the panel opens on its own (the person is on the
 * thread and no other panel is open) the web marks the notice read ({@link markReviewSeen}), so the
 * bell counts only passes whose candidates the person has not seen.
 */

export async function noticeCandidatesReady(
  tx: KaijuTx,
  pass: { teamId: string; userId: string; threadId: string; passId: string },
  count: number,
): Promise<void> {
  if (count <= 0) return;
  await registerMemoryReminder(tx, pass.teamId, {
    objectId: pass.passId,
    about: null,
    recipients: [pass.userId],
  });
  // Last: notifyMemory holds the recipient's digest lock until commit.
  await notifyMemory(tx, pass.teamId, [pass.userId], {
    kind: "memory.review.candidates_ready",
    threadId: pass.threadId,
    count,
    passId: pass.passId,
  });
}

/** Drops the pass's reminder once none of its candidates is open (decided or expired). */
export async function settleWhenDecided(tx: KaijuTx, teamId: string, passId: string): Promise<void> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM memory_candidates
     WHERE team_id = ${teamId} AND pass_id = ${passId} AND state = 'open' AND expires_at > now()
     LIMIT 1`);
  if (rows.length === 0) await settleMemoryReminders(tx, teamId, passId);
}

/** The person saw the thread's candidates: its candidates_ready notices are read. */
export async function markReviewSeen(
  tx: KaijuTx,
  ids: { teamId: string; userId: string; threadId: string },
): Promise<number> {
  const res = await tx.execute(sql`
    UPDATE notifications SET read_at = now()
     WHERE team_id = ${ids.teamId} AND user_id = ${ids.userId} AND thread_id = ${ids.threadId}
       AND kind = 'memory.review.candidates_ready' AND read_at IS NULL`);
  return res.rowCount ?? 0;
}
