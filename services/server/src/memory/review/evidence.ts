import { sql, type KaijuTx } from "@kaiju/db";
import type { StoredCandidate } from "./stored.js";

/**
 * Whether a candidate may be saved to the Workspace (KOBE-396; spec: Workspace candidates need a
 * quote from the person), checked against the thread at click: the person said or confirmed it
 * (never `inferred`), every quoted entry is still a message of this thread from the person or the
 * assistant (no tool output or summary), and at least one is the person's own. The pass checked
 * the quotes word for word when it ran (`learn/screen.ts`).
 */
export async function quotesThePerson(
  tx: KaijuTx,
  ids: { teamId: string; threadId: string },
  c: StoredCandidate,
): Promise<boolean> {
  if (c.source === "inferred") return false;
  const entryIds = [...new Set(c.evidence.map((e) => e.entry_id))];
  const { rows } = await tx.execute<{ entry_id: string; role: string | null }>(sql`
    SELECT entry_id, payload -> 'message' ->> 'role' AS role FROM thread_entries
     WHERE team_id = ${ids.teamId} AND thread_id = ${ids.threadId} AND type = 'message'
       AND entry_id IN (${sql.join(
         entryIds.map((id) => sql`${id}`),
         sql`, `,
       )})`);
  if (rows.length !== entryIds.length) return false;
  const roles = rows.map((r) => r.role);
  return roles.includes("user") && roles.every((r) => r === "user" || r === "assistant");
}
