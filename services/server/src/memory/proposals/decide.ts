import { z } from "zod";
import {
  createSemanticMemoryItemSchema,
  semanticMemoryKindSchema,
  semanticMemoryOverridesSchema,
  semanticMemoryStatementSchema,
  type SemanticMemoryItemDetail,
} from "@kobe/protocol";
import { MEMORY_PROPOSAL_TEXT_MAX, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { openOp } from "../items/context.js";
import { createItemIn } from "../items/create.js";
import { invalid, notAllowed } from "../items/errors.js";
import { deliverSiteNotices } from "../items/limits.js";
import { curates, type MemoryWho } from "../items/who.js";
import { noticeOpenAgain, workspaceOf } from "../review/ids.js";
import { returnCandidate } from "../review/stored.js";
import { noticeDecided } from "./notify.js";
import { lockProposal, type ProposalRow } from "./rows.js";

/**
 * Curators' decisions on Workspace proposals (KOBE-397, SM22): Approve (as proposed, or Edit and
 * approve: statement, kind), Request changes and Dismiss, each with the proposal row-locked in one
 * `withTeam()` transaction. Only curators (Team admins + memory stewards) decide, never the
 * proposer (self-approval is refused even for a proposer who has since become a curator).
 * Approval writes through the item store as the curator (switches, rights, limits, the memory
 * checks with their audited overrides), so the memory is in every member's next run. A reason
 * is required to turn a proposal down; Request changes opens the candidate again in the
 * proposer's To review, its clock unchanged.
 */

export const approveSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  overrides: semanticMemoryOverridesSchema.optional(),
});
export type ApproveBody = z.infer<typeof approveSchema>;

export const reasonSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason: the proposer reads it.")
    .max(MEMORY_PROPOSAL_TEXT_MAX, `A reason is at most ${MEMORY_PROPOSAL_TEXT_MAX} characters.`),
});

/** Refuses a decision the caller may not make on this proposal. */
function assertDecider(who: MemoryWho, p: ProposalRow): void {
  if (!curates(who, "team"))
    throw notAllowed("Only Team admins and memory stewards decide Workspace proposals.");
  if (p.proposerId === who.userId)
    throw notAllowed("You can't decide your own proposal: another curator does.");
}

async function setDecided(
  tx: KobeTx,
  teamId: string,
  id: string,
  who: MemoryWho,
  state: "approved" | "rejected",
  reason: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE memory_proposals SET state = ${state}, decided_by = ${who.userId},
           decided_at = now(), reason = ${reason}
     WHERE team_id = ${teamId} AND id = ${id} AND state = 'pending'`);
}

export async function approveProposal(
  db: KobeDb,
  who: MemoryWho,
  proposalId: string,
  body: ApproveBody,
): Promise<{ readonly proposal_id: string; readonly item: SemanticMemoryItemDetail }> {
  const teamId = workspaceOf(who);
  const done = await withTeam(db, teamId, async (tx) => {
    const p = await lockProposal(tx, teamId, proposalId);
    assertDecider(who, p);
    const op = await openOp(tx, who, "team");
    const statement = body.statement ?? p.statement;
    const kind = body.kind ?? p.kind;
    const parsed = createSemanticMemoryItemSchema.safeParse({
      scope: "team",
      kind,
      statement,
      ...(body.overrides ? { overrides: body.overrides } : {}),
    });
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Invalid memory.");
    // The curator's own write (Workspace versions have no `proposal` actor kind; the
    // proposal and its proposer are in `memory.proposal.accepted`).
    const item = await createItemIn(op, parsed.data);
    await setDecided(tx, teamId, p.id, who, "approved", null);
    await recordAudit(tx, {
      action: "memory.proposal.accepted",
      teamId,
      target: {
        proposalId: p.id,
        proposerId: p.proposerId,
        itemId: item.id,
        version: item.version,
        edited: statement !== p.statement || kind !== p.kind,
      },
    });
    await noticeDecided(tx, teamId, p, "accepted", who.userId);
    return { item, pending: op.pending };
  });
  if (done.pending.length > 0) await deliverSiteNotices(db, done.pending);
  return { proposal_id: proposalId, item: done.item };
}

/**
 * Turns a proposal down with a reason. `changes_requested`: its candidate opens again in the
 * proposer's To review (when its conversation is still there), to edit and propose again.
 */
export function turnDownProposal(
  db: KobeDb,
  who: MemoryWho,
  proposalId: string,
  outcome: "dismissed" | "changes_requested",
  reason: string,
): Promise<{ readonly proposal_id: string; readonly back_in_review: boolean }> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const p = await lockProposal(tx, teamId, proposalId);
    assertDecider(who, p);
    await setDecided(tx, teamId, p.id, who, "rejected", reason);
    let back = false;
    if (outcome === "changes_requested" && p.candidateId !== null) {
      back = await returnCandidate(tx, teamId, p.candidateId, p);
      const passId = await passOf(tx, teamId, p.candidateId);
      if (back && passId) await noticeOpenAgain(tx, teamId, p.proposerId, passId);
    }
    await recordAudit(tx, {
      action: "memory.proposal.dismissed",
      teamId,
      target: { proposalId: p.id, proposerId: p.proposerId, outcome },
    });
    await noticeDecided(tx, teamId, p, outcome, who.userId);
    return { proposal_id: p.id, back_in_review: back };
  });
}

async function passOf(tx: KobeTx, teamId: string, candidateId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ pass_id: string }>(sql`
    SELECT pass_id FROM memory_candidates WHERE team_id = ${teamId} AND id = ${candidateId}`);
  return rows[0]?.pass_id ?? null;
}
