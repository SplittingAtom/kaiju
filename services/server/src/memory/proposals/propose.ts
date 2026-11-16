import { z } from "zod";
import { semanticMemoryKindSchema, semanticMemoryStatementSchema } from "@kobe/protocol";
import { MEMORY_PROPOSAL_TEXT_MAX, sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { evaluateMemoryWrite } from "../checks.js";
import { openOp } from "../items/context.js";
import { invalid, MemoryItemError, notAllowed } from "../items/errors.js";
import { assertEnabled, curates, type MemoryWho } from "../items/who.js";
import { quotesThePerson } from "../review/evidence.js";
import { workspaceOf } from "../review/ids.js";
import { settleWhenDecided } from "../review/notify.js";
import { allowedScopes, saveShape } from "../review/rules.js";
import {
  lockCandidate,
  proposeCandidateRow,
  type CandidateRow,
  type StoredCandidate,
} from "../review/stored.js";
import { noticeProposed } from "./notify.js";
import { lockProposal, mayRepropose, proposalNotFound } from "./rows.js";

/**
 * Propose… (KOBE-397, SM22): a member who doesn't curate the Workspace sends a To review candidate
 * (as it is, or with its statement or kind edited) to the curators, with an optional note. Checked
 * at click in one `withTeam()` transaction, the candidate row-locked: the caller's own open
 * candidate (KOBE-396's rules), a new memory the Workspace may hold, in the person's own words
 * (`evidence.ts`); Workspace memories switched on; the text passes the hard memory checks (length,
 * secrets); warnings and Policy conflicts don't stop a proposal: curators see them and decide.
 * Curators save their own candidates directly instead (audited as `memory.candidate.accepted`).
 *
 * The proposal carries its statement, kind and note; the person's quotes and conversation stay on
 * the candidate it points at (curators read them there). A proposal sent back for changes opens
 * the candidate again: proposing it again keeps the first proposal's 30-day clock. An expired one
 * is sent again with one click ({@link repropose}) and starts a new clock.
 */

const rationaleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MEMORY_PROPOSAL_TEXT_MAX, `The note is at most ${MEMORY_PROPOSAL_TEXT_MAX} characters.`);

export const proposeSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  rationale: rationaleSchema.optional(),
});
export type ProposeBody = z.infer<typeof proposeSchema>;

export interface Proposed {
  readonly proposal_id: string;
  readonly candidate_id: string;
  readonly expires_at: string;
}

const alreadyCurator = () =>
  new MemoryItemError(
    "invalid_request",
    "You curate this workspace's memories: save it to the Workspace directly.",
  );

/** Refuses a proposal the proposer may not make from this candidate. */
async function assertProposable(
  tx: KobeTx,
  ids: { teamId: string; threadId: string },
  c: StoredCandidate,
  kind: ProposeBody["kind"],
): Promise<void> {
  if (saveShape(c).op !== "create")
    throw invalid("Only a new memory can be proposed: this one changes a memory you have.");
  if (!allowedScopes(c, kind ?? c.kind).includes("team"))
    throw invalid("This candidate can't be proposed to the Workspace: keep it for yourself.");
  if (!(await quotesThePerson(tx, ids, c)))
    throw notAllowed("A Workspace proposal needs your own words in this conversation.");
}

/** The hard checks (lengths, secrets) and the Workspace switch; warnings go to the curators. */
async function assertText(
  tx: KobeTx,
  who: MemoryWho,
  text: { statement: string; rationale?: string | undefined },
): Promise<void> {
  const op = await openOp(tx, who, "team");
  assertEnabled(op.memory, "team");
  const found = await evaluateMemoryWrite(op, {
    scope: "team",
    policy: false,
    statement: text.statement,
    justification: text.rationale,
  });
  if (found.invalid !== null) throw invalid(found.invalid);
  if (found.secret !== null)
    throw new MemoryItemError(
      "memory_secret",
      `This looks like ${found.secret.label}. Remove it: secrets can never be saved in memory.`,
    );
}

interface NewProposal {
  readonly candidateId: string;
  readonly statement: string;
  readonly kind: string;
  readonly rationale: string | null;
  /** Keeps an earlier proposal's clock (a request round); null: 30 days from now. */
  readonly expiresAt: string | null;
}

async function insertProposal(
  tx: KobeTx,
  teamId: string,
  who: MemoryWho,
  p: NewProposal,
): Promise<{ id: string; expires_at: string }> {
  const expires = p.expiresAt === null ? sql`DEFAULT` : sql`${p.expiresAt}::timestamptz`;
  const { rows } = await tx.execute<{ id: string; expires_at: string | Date }>(sql`
    INSERT INTO memory_proposals (team_id, source, candidate_ref, statement, kind, rationale,
                                  proposer_id, expires_at)
    VALUES (${teamId}, 'candidate', ${p.candidateId}, ${p.statement}, ${p.kind}, ${p.rationale},
            ${who.userId}, ${expires})
    RETURNING id, expires_at`);
  const row = rows[0];
  if (!row) throw new Error("memory proposal insert returned nothing");
  return { id: row.id, expires_at: new Date(row.expires_at).toISOString() };
}

/** The clock of the proposal a returned candidate came back from, while it still runs. */
async function returnedClock(tx: KobeTx, teamId: string, row: CandidateRow) {
  const previous = row.candidate.returned?.proposal_id;
  if (!previous) return { previousId: null, expiresAt: null };
  const { rows } = await tx.execute<{ expires_at: string | Date }>(sql`
    SELECT expires_at FROM memory_proposals
     WHERE team_id = ${teamId} AND id = ${previous} AND expires_at > now()`);
  const at = rows[0]?.expires_at;
  return { previousId: previous, expiresAt: at ? new Date(at).toISOString() : null };
}

export function proposeCandidate(
  db: KobeDb,
  who: MemoryWho,
  candidateId: string,
  body: ProposeBody,
): Promise<Proposed> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const row = await lockCandidate(tx, { teamId, userId: who.userId }, candidateId);
    if (curates(who, "team")) throw alreadyCurator();
    await assertProposable(tx, { teamId, threadId: row.threadId }, row.candidate, body.kind);
    const c = row.candidate;
    const statement = body.statement ?? c.statement;
    const kind = body.kind ?? c.kind;
    await assertText(tx, who, { statement, rationale: body.rationale });
    const clock = await returnedClock(tx, teamId, row);
    const made = await insertProposal(tx, teamId, who, {
      candidateId: row.id,
      statement,
      kind,
      rationale: body.rationale ?? null,
      expiresAt: clock.expiresAt,
    });
    await proposeCandidateRow(tx, teamId, row.id, made.id);
    await settleWhenDecided(tx, teamId, row.passId);
    await recordAudit(tx, {
      action: "memory.proposal.created",
      teamId,
      target: {
        proposalId: made.id,
        candidateId: row.id,
        edited: statement !== c.statement || kind !== c.kind,
        repropose: clock.previousId !== null,
        previousId: clock.previousId,
      },
    });
    await noticeProposed(tx, teamId, { id: made.id, proposerId: who.userId });
    return { proposal_id: made.id, candidate_id: row.id, expires_at: made.expires_at };
  });
}

/**
 * One-click re-propose of the caller's expired proposal (SM22): the same statement, kind and note,
 * from the same candidate, re-checked as a new proposal (its conversation must still be there and
 * still quote the person), with a new 30-day clock. A pending one past its expiry is marked
 * expired first (the sweep, KOBE-651, may not have run yet).
 */
export function repropose(db: KobeDb, who: MemoryWho, proposalId: string): Promise<Proposed> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const old = await lockProposal(tx, teamId, proposalId, "any");
    if (old.proposerId !== who.userId) throw proposalNotFound();
    if (!mayRepropose(old) || old.candidate === null || old.threadId === null)
      throw new MemoryItemError(
        "memory_item_inactive",
        old.state === "expired" || old.lapsed
          ? "Its conversation is gone, so it can't be proposed again."
          : "Only an expired proposal can be proposed again.",
      );
    if (curates(who, "team")) throw alreadyCurator();
    const candidateId = old.candidateId as string;
    await assertProposable(tx, { teamId, threadId: old.threadId }, old.candidate, old.kind);
    await assertText(tx, who, { statement: old.statement, rationale: old.rationale ?? undefined });
    if (old.lapsed)
      await tx.execute(sql`
        UPDATE memory_proposals SET state = 'expired', decided_at = now()
         WHERE team_id = ${teamId} AND id = ${old.id} AND state = 'pending'`);
    const made = await insertProposal(tx, teamId, who, {
      candidateId,
      statement: old.statement,
      kind: old.kind,
      rationale: old.rationale,
      expiresAt: null,
    });
    await tx.execute(sql`
      UPDATE memory_candidates SET payload = payload || ${JSON.stringify({ proposal_id: made.id })}::jsonb
       WHERE team_id = ${teamId} AND id = ${candidateId}`);
    await recordAudit(tx, {
      action: "memory.proposal.created",
      teamId,
      target: {
        proposalId: made.id,
        candidateId,
        edited: false,
        repropose: true,
        previousId: old.id,
      },
    });
    await noticeProposed(tx, teamId, { id: made.id, proposerId: who.userId });
    return { proposal_id: made.id, candidate_id: candidateId, expires_at: made.expires_at };
  });
}
