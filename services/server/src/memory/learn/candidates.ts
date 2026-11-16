import { sql, type KobeTx } from "@kobe/db";
import { evaluateMemoryWrite } from "../checks.js";
import { locate } from "../items/location.js";
import type { MemoryWho } from "../items/who.js";
import type { EffectiveMemory } from "../switch-model.js";
import { statementHash, type KnownStatements, type SelectedCandidate } from "./validate.js";

/**
 * The pass's database checks and its candidates (KOBE-393, SM16, SM18, SM23), in the caller's
 * `withTeam()` transaction. Nothing here saves a memory: candidates wait in To review for the
 * person (KOBE-395/396).
 *
 * The shared save checks (memory/checks.ts, A4) run on each selected candidate in the scope it
 * would be saved to (a project's Notes are judged like the Workspace): a credential or an
 * over-long field drops it; lint and personal-data warnings, links, near-duplicates of existing
 * items and Policy conflicts are kept on the candidate for the reviewer (a Policy conflict blocks
 * its save until someone who curates the scope overrides it, as for any save).
 */

/** The person's open candidates in this Workspace and their dismissals in this thread. */
export async function readKnownStatements(
  tx: KobeTx,
  ids: { teamId: string; userId: string; threadId: string },
): Promise<KnownStatements> {
  const open = await tx.execute<{ statement: unknown }>(sql`
    SELECT c.payload -> 'statement' AS statement FROM memory_candidates c
      JOIN memory_learning_passes p ON p.team_id = c.team_id AND p.id = c.pass_id
     WHERE c.team_id = ${ids.teamId} AND p.user_id = ${ids.userId}
       AND c.state = 'open' AND c.expires_at > now()`);
  const dismissed = await tx.execute<{ statement_hash: string }>(sql`
    SELECT statement_hash FROM memory_dismissals
     WHERE team_id = ${ids.teamId} AND thread_id = ${ids.threadId} AND user_id = ${ids.userId}`);
  return {
    open: new Set(
      open.rows.flatMap((r) =>
        typeof r.statement === "string" ? [statementHash(r.statement)] : [],
      ),
    ),
    dismissed: new Set(dismissed.rows.map((r) => r.statement_hash)),
  };
}

export interface CheckedCandidate extends SelectedCandidate {
  readonly warnings: readonly string[];
  readonly policyConflicts: readonly { readonly id: string; readonly version: number }[];
  readonly nearDuplicates: readonly { readonly id: string; readonly version: number }[];
}

export type CheckDropReason = "secret" | "invalid";

const scopeOf = (c: SelectedCandidate) =>
  c.destination === "portable" ? "portable" : c.destination === "user" ? "user" : "team";

/** Runs the shared save checks on each candidate; drops credentials and invalid text. */
export async function checkCandidates(
  tx: KobeTx,
  env: { teamId: string; userId: string; memory: EffectiveMemory },
  selected: readonly SelectedCandidate[],
): Promise<{
  kept: CheckedCandidate[];
  dropped: { statement: string; reason: CheckDropReason }[];
}> {
  const who: MemoryWho = {
    userId: env.userId,
    teamId: env.teamId,
    teamRole: null,
    memorySteward: false,
    siteRole: null,
    grants: [],
  };
  const kept: CheckedCandidate[] = [];
  const dropped: { statement: string; reason: CheckDropReason }[] = [];
  for (const c of selected) {
    const scope = scopeOf(c);
    const findings = await evaluateMemoryWrite(
      { tx, loc: locate(scope, env.teamId, env.userId), memory: env.memory, who },
      {
        scope,
        policy: false,
        statement: c.candidate.statement,
        justification: c.candidate.rationale,
        ...(c.candidate.target_id === null ? {} : { except: [c.candidate.target_id] }),
      },
    );
    if (findings.secret !== null)
      dropped.push({ statement: c.candidate.statement, reason: "secret" });
    else if (findings.invalid !== null)
      dropped.push({ statement: c.candidate.statement, reason: "invalid" });
    else
      kept.push({
        ...c,
        warnings: findings.warnings.map((w) => w.code),
        policyConflicts: findings.policyConflicts.map(({ id, version }) => ({ id, version })),
        nearDuplicates: findings.duplicates.map(({ id, version }) => ({ id, version })),
      });
  }
  return { kept, dropped };
}

/** The stored candidate (`memory_candidates.payload`), as To review shows it. */
export function candidatePayload(c: CheckedCandidate, promptVersion: string) {
  const k = c.candidate;
  return {
    statement: k.statement,
    kind: k.kind,
    destination: c.destination,
    suggested_scope: k.suggested_scope,
    portable: k.portable,
    project_specific: k.project_specific,
    source: k.source,
    operation: k.operation,
    target_id: k.target_id,
    confidence: k.confidence,
    rationale: k.rationale,
    evidence: k.evidence,
    statement_hash: c.hash,
    warnings: c.warnings,
    policy_conflicts: c.policyConflicts,
    near_duplicates: c.nearDuplicates,
    prompt_version: promptVersion,
  };
}

/** Stores the candidates in order (`ord` 0..n-1). */
export async function insertCandidates(
  tx: KobeTx,
  ids: { teamId: string; passId: string },
  candidates: readonly CheckedCandidate[],
  promptVersion: string,
): Promise<void> {
  if (candidates.length === 0) return;
  await tx.execute(sql`
    INSERT INTO memory_candidates (team_id, pass_id, ord, payload)
    VALUES ${sql.join(
      candidates.map(
        (c, ord) =>
          sql`(${ids.teamId}, ${ids.passId}, ${ord}, ${JSON.stringify(candidatePayload(c, promptVersion))}::jsonb)`,
      ),
      sql`, `,
    )}`);
}
