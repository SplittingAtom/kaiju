import { z } from "zod";
import {
  createSemanticMemoryItemSchema,
  semanticMemoryKindSchema,
  semanticMemoryOverridesSchema,
  semanticMemoryStatementSchema,
  type SemanticMemoryItemDetail,
} from "@kobe/protocol";
import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { snapshotPortableHolds } from "../../legal-hold/portable-hold.js";
import { openOp, type Op } from "../items/context.js";
import { createItemIn } from "../items/create.js";
import { archiveItemIn, patchItemIn, revertItemIn } from "../items/edit.js";
import { deliverSiteNotices, type PendingSiteNotices } from "../items/limits.js";
import { invalid, notAllowed } from "../items/errors.js";
import { readItem } from "../items/rows.js";
import type { MemoryWho } from "../items/who.js";
import { statementHash } from "../learn/validate.js";
import { quotesThePerson } from "./evidence.js";
import { noticeOpenAgain, workspaceOf } from "./ids.js";
import { settleWhenDecided } from "./notify.js";
import {
  allowedScopes,
  inSaveAllMine,
  saveShape,
  suggestedScope,
  type ReviewScope,
} from "./rules.js";
import {
  decideCandidate,
  lockCandidate,
  reopenCandidate,
  type CandidateRow,
  type Decision,
  type MemoryDecision,
} from "./stored.js";

/**
 * To review's decisions (KOBE-396, SM16): Save (as it is, or edited: statement, kind, scope),
 * Dismiss, Save all mine and Undo. Every click re-checks on the server, in one `withTeam()`
 * transaction with the candidate row-locked: the candidate is the caller's (the pass's person and
 * still the thread's author), open and unexpired; the scope is one {@link allowedScopes} allows;
 * a Workspace save quotes the person (`evidence.ts`). The memory itself is written through the
 * item store (KOBE-378: switches, rights, limits, `memory/checks.ts`, Policy conflicts with their
 * audited override), on the same transaction, so a refused save leaves the candidate open.
 *
 * Project-notes candidates can also be kept personally here; Add to project notes (KOBE-398) is
 * `project-notes.ts` beside Save. Propose… (KOBE-397) likewise.
 */

export const saveCandidateSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  kind: semanticMemoryKindSchema.optional(),
  scope: z.enum(["user", "portable", "team"]).optional(),
  /** Required for a portable save (it follows the person into every Workspace). */
  confirm_portable: z.literal(true).optional(),
  overrides: semanticMemoryOverridesSchema.optional(),
});
export type SaveCandidate = z.infer<typeof saveCandidateSchema>;

export const SAVE_ALL_MAX = 50;
export const candidateIdsSchema = z.strictObject({
  candidate_ids: z.array(z.uuid()).min(1).max(SAVE_ALL_MAX),
});

export interface SavedCandidate {
  readonly candidate_id: string;
  readonly item: SemanticMemoryItemDetail;
}

/** The caller's transaction for decisions: notices to Site curators go out after commit. */
async function inReview<T>(
  db: KobeDb,
  who: MemoryWho,
  fn: (tx: KobeTx, ops: OpsFor) => Promise<T>,
): Promise<T> {
  const teamId = workspaceOf(who);
  // Read before the transaction: an update of a portable memory may prune versions (review M1).
  const holds = await snapshotPortableHolds(db);
  const opened: Op[] = [];
  const out = await withTeam(db, teamId, (tx) =>
    fn(tx, async (scope) => {
      const op = await openOp(tx, who, scope, scope === "portable" ? holds : undefined);
      opened.push(op);
      return op;
    }),
  );
  const pending: PendingSiteNotices = opened.flatMap((o) => o.pending);
  if (pending.length > 0) await deliverSiteNotices(db, pending);
  return out;
}

type OpsFor = (scope: ReviewScope) => Promise<Op>;

/** Saves one locked candidate through the item store; returns the item and the decision. */
async function saveLocked(
  tx: KobeTx,
  ops: OpsFor,
  who: MemoryWho,
  row: CandidateRow,
  body: SaveCandidate,
  batch: boolean,
): Promise<SavedCandidate> {
  const teamId = workspaceOf(who);
  const c = row.candidate;
  const kind = body.kind ?? c.kind;
  const scope = body.scope ?? suggestedScope(c);
  if (!allowedScopes(c, kind).includes(scope))
    throw invalid(
      scope === "portable"
        ? "Only a preference can be kept in all your workspaces."
        : "This candidate can't be saved there.",
    );
  if (scope === "portable" && body.confirm_portable !== true)
    throw invalid("Confirm that this memory goes with you to every workspace.");
  if (scope === "team" && !(await quotesThePerson(tx, { teamId, threadId: row.threadId }, c)))
    throw notAllowed("A Workspace memory needs your own words in this conversation.");

  const op = await ops(scope);
  const statement = body.statement ?? c.statement;
  const links =
    scope === "portable"
      ? {}
      : {
          source_thread_id: row.threadId,
          source_entry_ids: [...new Set(c.evidence.map((e) => e.entry_id))],
        };
  const shape = saveShape(c);
  let item: SemanticMemoryItemDetail;
  if (shape.op === "update") {
    const target = await readItem(tx, op.loc, shape.targetId);
    if (!target) throw invalid("The memory this candidate changes is gone.");
    item = await patchItemIn(op, shape.targetId, {
      expected_version: target.current_version,
      statement,
      ...(body.kind ? { kind } : {}),
      ...(body.overrides ? { overrides: body.overrides } : {}),
    });
  } else {
    const parsed = createSemanticMemoryItemSchema.safeParse({
      scope,
      kind,
      statement,
      ...links,
      ...(scope === "portable" ? { confirm_portable: true } : {}),
      ...(shape.op === "supersede" ? { supersedes_id: shape.targetId } : {}),
      ...(body.overrides ? { overrides: body.overrides } : {}),
    });
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Invalid memory.");
    item = await createItemIn(op, parsed.data);
  }
  const decision: MemoryDecision = {
    item_id: item.id,
    scope,
    version: item.version,
    op: shape.op,
    batch,
  };
  await decideCandidate(tx, teamId, row.id, "saved", decision);
  await recordAudit(tx, {
    action: "memory.candidate.accepted",
    teamId,
    target: {
      candidateId: row.id,
      passId: row.passId,
      threadId: row.threadId,
      scope,
      itemId: item.id,
      version: item.version,
      edited: statement !== c.statement || kind !== c.kind || scope !== suggestedScope(c),
      batch,
    },
  });
  return { candidate_id: row.id, item };
}

export function saveCandidate(
  db: KobeDb,
  who: MemoryWho,
  candidateId: string,
  body: SaveCandidate,
): Promise<SavedCandidate> {
  return inReview(db, who, async (tx, ops) => {
    const row = await lockCandidate(
      tx,
      { teamId: workspaceOf(who), userId: who.userId },
      candidateId,
    );
    const saved = await saveLocked(tx, ops, who, row, body, false);
    await settleWhenDecided(tx, workspaceOf(who), row.passId);
    return saved;
  });
}

/** Dismiss: closed, and later passes over the thread don't offer the statement again. */
export function dismissCandidate(
  db: KobeDb,
  who: MemoryWho,
  candidateId: string,
): Promise<{ readonly candidate_id: string }> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const row = await lockCandidate(tx, { teamId, userId: who.userId }, candidateId);
    await decideCandidate(tx, teamId, row.id, "dismissed");
    // The pass's own hash (validate.ts statementHash), recomputed: a stored row is data.
    await tx.execute(
      sqlDismissal(teamId, row.threadId, who.userId, statementHash(row.candidate.statement)),
    );
    await recordAudit(tx, {
      action: "memory.candidate.dismissed",
      teamId,
      target: { candidateId: row.id, passId: row.passId, threadId: row.threadId },
    });
    await settleWhenDecided(tx, teamId, row.passId);
    return { candidate_id: row.id };
  });
}

const sqlDismissal = (teamId: string, threadId: string, userId: string, hash: string) => sql`
  INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash)
  VALUES (${teamId}, ${threadId}, ${userId}, ${hash}) ON CONFLICT DO NOTHING`;

/**
 * Save all mine: the listed candidates, all at once or none (one transaction), each a new personal
 * memory (`rules.ts` `inSaveAllMine`) saved as suggested. Any refusal (a warning that needs
 * Save anyway, a full scope, a decided candidate) saves nothing and names the candidate, so the
 * person handles it on its card and tries again. One Undo takes the whole batch back.
 */
export function saveAllMine(
  db: KobeDb,
  who: MemoryWho,
  candidateIds: readonly string[],
): Promise<{ readonly saved: readonly SavedCandidate[] }> {
  const teamId = workspaceOf(who);
  return inReview(db, who, async (tx, ops) => {
    const saved: SavedCandidate[] = [];
    const passes = new Set<string>();
    for (const id of [...new Set(candidateIds)]) {
      const row = await lockCandidate(tx, { teamId, userId: who.userId }, id);
      const scope = suggestedScope(row.candidate);
      if (!inSaveAllMine(row.candidate))
        throw invalid("Save all mine saves new personal memories only: save this one on its card.");
      const body = scope === "portable" ? { confirm_portable: true as const } : {};
      saved.push(await saveLocked(tx, ops, who, row, body, true));
      passes.add(row.passId);
    }
    for (const passId of passes) await settleWhenDecided(tx, teamId, passId);
    return { saved };
  });
}

/**
 * Undo of a save (one card's, or a whole Save all mine): each candidate is open again and its
 * memory taken back through the item store: a new memory is archived (as the editor's Undo does),
 * an update reverted to the version before it. All or nothing; refused when a memory changed
 * since (409 `memory_version_conflict`) or the save replaced another memory (that stays as saved).
 */
export function undoSaves(
  db: KobeDb,
  who: MemoryWho,
  candidateIds: readonly string[],
): Promise<{ readonly reopened: readonly string[] }> {
  const teamId = workspaceOf(who);
  return inReview(db, who, async (tx, ops) => {
    const reopened: string[] = [];
    for (const id of [...new Set(candidateIds)]) {
      const row = await lockCandidate(tx, { teamId, userId: who.userId }, id, "saved");
      const d = row.candidate.decision as Decision;
      if (d.op === "project_notes")
        throw invalid("Added to project notes: change it in the project's Notes (its history).");
      const op = await ops(d.scope);
      if (d.op === "create") await archiveItemIn(op, d.item_id, { expected_version: d.version });
      else if (d.op === "update")
        await revertItemIn(op, d.item_id, { expected_version: d.version, version: d.version - 1 });
      else throw invalid("A memory that replaced another can't be undone here: edit it in Memory.");
      await reopenCandidate(tx, teamId, id);
      await noticeOpenAgain(tx, teamId, who.userId, row.passId);
      reopened.push(id);
    }
    return { reopened };
  });
}
