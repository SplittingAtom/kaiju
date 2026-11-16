import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { locate } from "../items/location.js";
import { readItem } from "../items/rows.js";
import { curates, type MemoryWho } from "../items/who.js";
import { workspaceOf } from "./ids.js";
import { allowedScopes, inSaveAllMine, scopeLocked, suggestedScope } from "./rules.js";
import {
  candidateNotFound,
  latestSkillHints,
  listOpenCandidates,
  type CandidateRow,
} from "./stored.js";

/**
 * `GET /v1/memory/review?thread_id=` (KOBE-396): the caller's open candidates in their thread,
 * as To review's cards show them: the statement and why, evidence quotes (entry ids, so the card
 * scrolls to the message), the scopes allowed and the suggested one, the item an update,
 * supersede or conflict acts on (for the inline diff), Policy conflicts and near-duplicates with
 * their statements, the warnings the pass's checks found, and the latest pass's skill hints.
 * Only the thread's author sees its candidates; anyone else gets 404.
 */

interface Related {
  readonly id: string;
  readonly version: number;
  readonly statement: string;
}

async function relatedItem(
  tx: KobeTx,
  who: MemoryWho,
  scope: "user" | "portable" | "team",
  id: string,
): Promise<Related | null> {
  const row = await readItem(tx, locate(scope, workspaceOf(who), who.userId), id);
  return row && row.status === "active"
    ? { id: row.id, version: row.current_version, statement: row.statement }
    : null;
}

export async function policyStatements(
  tx: KobeTx,
  refs: readonly { id: string; version: number }[],
): Promise<Related[]> {
  if (refs.length === 0) return [];
  const { rows } = await tx.execute<{ id: string; version: number; statement: string }>(sql`
    SELECT i.id, i.current_version AS version, v.statement FROM site_memory_items i
      JOIN site_memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
     WHERE i.policy AND i.status = 'active' AND i.id IN (${sql.join(
       refs.map((r) => sql`${r.id}::uuid`),
       sql`, `,
     )})`);
  return rows;
}

async function card(tx: KobeTx, who: MemoryWho, row: CandidateRow) {
  const c = row.candidate;
  const scope = suggestedScope(c);
  const target = c.target_id === null ? null : await relatedItem(tx, who, scope, c.target_id);
  const dupes: Related[] = [];
  for (const d of c.near_duplicates.slice(0, 3)) {
    const found = await relatedItem(tx, who, scope, d.id);
    if (found) dupes.push(found);
  }
  return {
    id: row.id,
    pass_id: row.passId,
    statement: c.statement,
    kind: c.kind,
    destination: c.destination,
    scope,
    allowed_scopes: allowedScopes(c),
    scope_locked: scopeLocked(c),
    save_all_mine: inSaveAllMine(c),
    project_specific: c.project_specific,
    source: c.source,
    operation: c.operation,
    target,
    confidence: c.confidence,
    rationale: c.rationale,
    evidence: c.evidence,
    warnings: c.warnings,
    policy_conflicts: await policyStatements(tx, c.policy_conflicts),
    near_duplicates: dupes,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}

export type ReviewCard = Awaited<ReturnType<typeof card>>;

export function listReview(db: KobeDb, who: MemoryWho, threadId: string) {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const { rows } = await tx.execute<{ owner_user_id: string | null }>(sql`
      SELECT owner_user_id FROM threads WHERE team_id = ${teamId} AND id = ${threadId}`);
    if (rows[0]?.owner_user_id !== who.userId) throw candidateNotFound();
    const ids = { teamId, userId: who.userId, threadId };
    const open = await listOpenCandidates(tx, ids);
    const candidates: ReviewCard[] = [];
    for (const row of open) candidates.push(await card(tx, who, row));
    return {
      thread_id: threadId,
      can_curate_workspace: curates(who, "team"),
      candidates,
      skill_hints: await latestSkillHints(tx, ids),
    };
  });
}
