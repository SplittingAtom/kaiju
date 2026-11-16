import { z } from "zod";
import {
  MEMORY_CANDIDATE_OPERATIONS,
  MEMORY_CANDIDATE_SCOPES,
  MEMORY_CANDIDATE_SOURCES,
  memorySkillHintSchema,
  semanticMemoryKindSchema,
  uuidSchema,
  type MemorySkillHint,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { MemoryItemError, inactive } from "../items/errors.js";

/**
 * The stored candidates To review shows and decides (KOBE-396): `memory_candidates.payload` as the
 * pass wrote it (`learn/candidates.ts` `candidatePayload`), parsed again on every read (a row is
 * data, never trusted), and the rows of one person's thread. `decision` is added when a candidate
 * is saved (the item it made, for Undo) and removed when Undo reopens it.
 */

const ref = z.object({ id: uuidSchema, version: z.number().int().positive() });

export const decisionSchema = z.object({
  item_id: uuidSchema,
  scope: z.enum(["user", "portable", "team"]),
  /** The item's version right after the save (Undo refuses once it moved on). */
  version: z.number().int().positive(),
  op: z.enum(["create", "update", "supersede"]),
  /** Saved by Save all mine: Undo of that batch reopens it. */
  batch: z.boolean(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const storedCandidateSchema = z.object({
  statement: z.string().min(1),
  kind: semanticMemoryKindSchema,
  destination: z.enum(["user", "portable", "team", "project_notes"]),
  suggested_scope: z.enum(MEMORY_CANDIDATE_SCOPES),
  portable: z.boolean(),
  project_specific: z.boolean(),
  source: z.enum(MEMORY_CANDIDATE_SOURCES),
  operation: z.enum(MEMORY_CANDIDATE_OPERATIONS),
  target_id: uuidSchema.nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  evidence: z.array(z.object({ entry_id: z.string().min(1), quote: z.string().min(1) })).min(1),
  statement_hash: z.string(),
  warnings: z.array(z.string()).default([]),
  policy_conflicts: z.array(ref).default([]),
  near_duplicates: z.array(ref).default([]),
  decision: decisionSchema.optional(),
  /** Proposed to the Workspace (KOBE-397): the proposal it became. */
  proposal_id: uuidSchema.optional(),
  /** A curator sent its proposal back for changes: open again, with the proposal's clock. */
  returned: z.object({ proposal_id: uuidSchema }).optional(),
});
export type StoredCandidate = z.infer<typeof storedCandidateSchema>;

export interface CandidateRow {
  readonly id: string;
  readonly passId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly state: string;
  readonly expired: boolean;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly candidate: StoredCandidate;
}

type RawRow = {
  id: string;
  pass_id: string;
  thread_id: string;
  user_id: string;
  owner_user_id: string | null;
  state: string;
  expired: boolean;
  expires_at: string | Date;
  created_at: string | Date;
  payload: unknown;
};

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function toRow(r: RawRow): CandidateRow | null {
  const parsed = storedCandidateSchema.safeParse(r.payload);
  if (!parsed.success) return null;
  return {
    id: r.id,
    passId: r.pass_id,
    threadId: r.thread_id,
    userId: r.user_id,
    state: r.state,
    expired: r.expired,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    candidate: parsed.data,
  };
}

const COLUMNS = sql`c.id, c.pass_id, p.thread_id, p.user_id, t.owner_user_id, c.state,
  c.expires_at <= now() AS expired, c.expires_at, c.created_at, c.payload`;
const FROM = sql`memory_candidates c
  JOIN memory_learning_passes p ON p.team_id = c.team_id AND p.id = c.pass_id
  JOIN threads t ON t.team_id = p.team_id AND t.id = p.thread_id`;

/**
 * The person's open, unexpired candidates in their thread: newest pass first, each pass in its
 * order. A later pass adds to the open set; a statement already open (same `statement_hash`) shows
 * once (the pass's own selection drops those; this keeps a race from showing two).
 */
export async function listOpenCandidates(
  tx: KobeTx,
  ids: { teamId: string; userId: string; threadId: string },
): Promise<CandidateRow[]> {
  const { rows } = await tx.execute<RawRow>(sql`
    SELECT ${COLUMNS} FROM ${FROM}
     WHERE c.team_id = ${ids.teamId} AND p.thread_id = ${ids.threadId}
       AND p.user_id = ${ids.userId} AND t.owner_user_id = ${ids.userId}
       AND c.state = 'open' AND c.expires_at > now()
     ORDER BY p.created_at DESC, c.ord ASC`);
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const raw of rows) {
    const row = toRow(raw);
    if (!row || seen.has(row.candidate.statement_hash)) continue;
    seen.add(row.candidate.statement_hash);
    out.push(row);
  }
  return out;
}

/** Skill hints of the person's latest completed pass on the thread (at most two). */
export async function latestSkillHints(
  tx: KobeTx,
  ids: { teamId: string; userId: string; threadId: string },
): Promise<MemorySkillHint[]> {
  const { rows } = await tx.execute<{ hints: unknown }>(sql`
    SELECT usage -> 'skill_hints' AS hints FROM memory_learning_passes
     WHERE team_id = ${ids.teamId} AND thread_id = ${ids.threadId} AND user_id = ${ids.userId}
       AND status = 'completed'
     ORDER BY finished_at DESC LIMIT 1`);
  const parsed = z
    .array(memorySkillHintSchema)
    .max(2)
    .safeParse(rows[0]?.hints ?? []);
  return parsed.success ? parsed.data : [];
}

export const candidateNotFound = () =>
  new MemoryItemError("memory_item_not_found", "No such candidate in your To review.");

/**
 * One candidate of the caller's, row-locked for a decision. Refused unless the caller is the pass's
 * person and still the thread's author (404, so others learn nothing). `open` (default) also
 * refuses a decided or expired candidate (409 `memory_item_inactive`).
 */
export async function lockCandidate(
  tx: KobeTx,
  ids: { teamId: string; userId: string },
  candidateId: string,
  want: "open" | "saved" = "open",
): Promise<CandidateRow> {
  const { rows } = await tx.execute<RawRow>(sql`
    SELECT ${COLUMNS} FROM ${FROM}
     WHERE c.team_id = ${ids.teamId} AND c.id = ${candidateId}
     FOR UPDATE OF c`);
  const raw = rows[0];
  if (!raw || raw.user_id !== ids.userId || raw.owner_user_id !== ids.userId)
    throw candidateNotFound();
  const row = toRow(raw);
  if (!row) throw candidateNotFound();
  if (want === "open") {
    if (row.state !== "open") throw inactive("This candidate was already decided.");
    if (row.expired) throw inactive("This candidate expired: candidates wait 14 days.");
  } else if (row.state !== "saved" || !row.candidate.decision) {
    throw inactive("Only a saved candidate can be undone.");
  }
  return row;
}

/** Closes an open candidate (`saved` with its decision, or `dismissed`). */
export async function decideCandidate(
  tx: KobeTx,
  teamId: string,
  candidateId: string,
  state: "saved" | "dismissed",
  decision?: Decision,
): Promise<void> {
  const extra = decision ? JSON.stringify({ decision }) : "{}";
  await tx.execute(sql`
    UPDATE memory_candidates SET state = ${state}, decided_at = now(),
           payload = payload || ${extra}::jsonb
     WHERE team_id = ${teamId} AND id = ${candidateId} AND state = 'open'`);
}

/** Proposed (KOBE-397): closed in To review, pointing at its proposal. */
export async function proposeCandidateRow(
  tx: KobeTx,
  teamId: string,
  candidateId: string,
  proposalId: string,
): Promise<void> {
  const extra = JSON.stringify({ proposal_id: proposalId });
  await tx.execute(sql`
    UPDATE memory_candidates SET state = 'proposed', decided_at = now(),
           payload = (payload - 'returned') || ${extra}::jsonb
     WHERE team_id = ${teamId} AND id = ${candidateId} AND state = 'open'`);
}

/**
 * A curator sent the proposal back (KOBE-397): the candidate is open again in its person's To
 * review, marked with the proposal, and lives at least as long as the proposal's clock (request
 * rounds don't reset it).
 */
export async function returnCandidate(
  tx: KobeTx,
  teamId: string,
  candidateId: string,
  proposal: { id: string; expiresAt: string },
): Promise<boolean> {
  const extra = JSON.stringify({ returned: { proposal_id: proposal.id } });
  const res = await tx.execute(sql`
    UPDATE memory_candidates SET state = 'open', decided_at = NULL,
           expires_at = greatest(expires_at, ${proposal.expiresAt}::timestamptz),
           payload = (payload - 'proposal_id') || ${extra}::jsonb
     WHERE team_id = ${teamId} AND id = ${candidateId} AND state = 'proposed'`);
  return (res.rowCount ?? 0) > 0;
}

/** Undo: the saved candidate is open again (its expiry unchanged), without its decision. */
export async function reopenCandidate(
  tx: KobeTx,
  teamId: string,
  candidateId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE memory_candidates SET state = 'open', decided_at = NULL, payload = payload - 'decision'
     WHERE team_id = ${teamId} AND id = ${candidateId} AND state = 'saved'`);
}
