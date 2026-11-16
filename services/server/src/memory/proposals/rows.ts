import { sql, type KobeTx } from "@kobe/db";
import type { SemanticMemoryKind } from "@kobe/protocol";
import { MemoryItemError, inactive } from "../items/errors.js";
import { storedCandidateSchema, type StoredCandidate } from "../review/stored.js";

/**
 * Workspace proposals as stored (`memory_proposals`, KOBE-389; KOBE-397, SM22): one row per
 * proposal, with the candidate it came from when that still exists (its evidence quotes and
 * thread; a purged thread takes the candidate and clears `candidate_ref`). Rows are read inside
 * the caller's `withTeam()` transaction, so nothing crosses Workspaces.
 */

export interface ProposalRow {
  readonly id: string;
  readonly candidateId: string | null;
  readonly statement: string;
  readonly kind: SemanticMemoryKind;
  readonly rationale: string | null;
  readonly state: "pending" | "approved" | "rejected" | "expired";
  /** Pending past its expiry: treated as expired (the sweep that marks it is KOBE-651). */
  readonly lapsed: boolean;
  readonly proposerId: string;
  readonly proposerName: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  /** The source candidate's thread and payload (null once the thread is gone). */
  readonly threadId: string | null;
  readonly candidateState: string | null;
  readonly candidate: StoredCandidate | null;
}

type Raw = {
  id: string;
  candidate_ref: string | null;
  statement: string;
  kind: SemanticMemoryKind;
  rationale: string | null;
  state: ProposalRow["state"];
  lapsed: boolean;
  proposer_id: string;
  proposer_name: string | null;
  decided_by: string | null;
  decided_at: string | Date | null;
  reason: string | null;
  expires_at: string | Date;
  created_at: string | Date;
  thread_id: string | null;
  candidate_state: string | null;
  payload: unknown;
};

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function toRow(r: Raw): ProposalRow {
  const parsed = r.payload === null ? null : storedCandidateSchema.safeParse(r.payload);
  return {
    id: r.id,
    candidateId: r.candidate_ref,
    statement: r.statement,
    kind: r.kind,
    rationale: r.rationale,
    state: r.state,
    lapsed: r.lapsed,
    proposerId: r.proposer_id,
    proposerName: r.proposer_name ?? "A member",
    decidedBy: r.decided_by,
    decidedAt: r.decided_at === null ? null : iso(r.decided_at),
    reason: r.reason,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    threadId: r.thread_id,
    candidateState: r.candidate_state,
    candidate: parsed?.success ? parsed.data : null,
  };
}

const SELECT = sql`
  SELECT p.id, p.candidate_ref, p.statement, p.kind, p.rationale, p.state,
         (p.state = 'pending' AND p.expires_at <= now()) AS lapsed,
         p.proposer_id, u.name AS proposer_name, p.decided_by, p.decided_at, p.reason,
         p.expires_at, p.created_at, lp.thread_id, c.state AS candidate_state, c.payload
    FROM memory_proposals p
    JOIN users u ON u.id = p.proposer_id
    LEFT JOIN memory_candidates c ON c.team_id = p.team_id AND c.id = p.candidate_ref
    LEFT JOIN memory_learning_passes lp ON lp.team_id = c.team_id AND lp.id = c.pass_id`;

/** Most proposals one list returns (the queue is oldest first, a member's own newest first). */
export const PROPOSALS_LIST_MAX = 50;

/** The curators' queue: pending and unexpired, oldest first. */
export async function pendingProposals(tx: KobeTx, teamId: string): Promise<ProposalRow[]> {
  const { rows } = await tx.execute<Raw>(sql`${SELECT}
    WHERE p.team_id = ${teamId} AND p.state = 'pending' AND p.expires_at > now()
    ORDER BY p.created_at ASC LIMIT ${PROPOSALS_LIST_MAX}`);
  return rows.map(toRow);
}

/** A member's own proposals, newest first. */
export async function proposalsOf(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<ProposalRow[]> {
  const { rows } = await tx.execute<Raw>(sql`${SELECT}
    WHERE p.team_id = ${teamId} AND p.proposer_id = ${userId}
    ORDER BY p.created_at DESC LIMIT ${PROPOSALS_LIST_MAX}`);
  return rows.map(toRow);
}

export const proposalNotFound = () =>
  new MemoryItemError("memory_item_not_found", "No such proposal in this workspace.");

/**
 * One proposal, row-locked for a decision. `pending` (default) refuses a decided or expired one
 * (409 `memory_item_inactive`); `any` returns it whatever its state.
 */
export async function lockProposal(
  tx: KobeTx,
  teamId: string,
  id: string,
  want: "pending" | "any" = "pending",
): Promise<ProposalRow> {
  const { rows } = await tx.execute<Raw>(sql`${SELECT}
    WHERE p.team_id = ${teamId} AND p.id = ${id} FOR UPDATE OF p`);
  const raw = rows[0];
  if (!raw) throw proposalNotFound();
  const row = toRow(raw);
  if (want === "pending") {
    if (row.state !== "pending") throw inactive("This proposal was already decided.");
    if (row.lapsed) throw inactive("This proposal expired: proposals wait 30 days.");
  }
  return row;
}

/** Whether a proposal sent back for changes is open again in its proposer's To review. */
export function backInReview(p: ProposalRow): boolean {
  return (
    p.state === "rejected" &&
    p.candidateState === "open" &&
    p.candidate?.returned?.proposal_id === p.id
  );
}

/** Whether the proposer may send it again with one click (expired, its conversation still there). */
export function mayRepropose(p: ProposalRow): boolean {
  return (p.state === "expired" || p.lapsed) && p.candidateId !== null && p.threadId !== null;
}
