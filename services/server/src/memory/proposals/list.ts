import { withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { evaluateMemoryWrite } from "../checks.js";
import { openOp, type Op } from "../items/context.js";
import { notAllowed } from "../items/errors.js";
import { readItem } from "../items/rows.js";
import { curates, type MemoryWho } from "../items/who.js";
import { workspaceOf } from "../review/ids.js";
import { policyStatements } from "../review/list.js";
import {
  backInReview,
  mayRepropose,
  pendingProposals,
  proposalsOf,
  type ProposalRow,
} from "./rows.js";

/**
 * `GET /v1/memory/proposals` (KOBE-397): the curators' queue and a member's own proposals.
 * Curators (Team admins + memory stewards) see each pending proposal's statement, kind, proposer,
 * note, the person's evidence quotes and conversation (from its candidate), and what the memory
 * checks find now against this Workspace (warnings, near-duplicates, Policy conflicts). A member
 * sees their own proposals with the outcome, the curator's reason and whether they can propose
 * again. Everything is read in the caller's Workspace only.
 */

function base(p: ProposalRow) {
  return {
    id: p.id,
    statement: p.statement,
    kind: p.kind,
    rationale: p.rationale,
    state: p.lapsed ? ("expired" as const) : p.state,
    proposer: { id: p.proposerId, name: p.proposerName },
    thread_id: p.threadId,
    evidence: p.candidate?.evidence ?? [],
    reason: p.reason,
    decided_at: p.decidedAt,
    expires_at: p.expiresAt,
    created_at: p.createdAt,
  };
}

async function related(op: Op, refs: readonly { id: string }[]) {
  const out: { id: string; version: number; statement: string }[] = [];
  for (const r of refs.slice(0, 3)) {
    const row = await readItem(op.tx, op.loc, r.id);
    if (row && row.status === "active")
      out.push({ id: row.id, version: row.current_version, statement: row.statement });
  }
  return out;
}

async function queueCard(tx: KobeTx, op: Op, p: ProposalRow) {
  const found = await evaluateMemoryWrite(op, {
    scope: "team",
    policy: false,
    statement: p.statement,
  });
  return {
    ...base(p),
    warnings: found.warnings.map((w) => w.code),
    near_duplicates: await related(op, found.duplicates),
    policy_conflicts: await policyStatements(tx, found.policyConflicts),
  };
}

export type ProposalCard = Awaited<ReturnType<typeof queueCard>>;

export function listQueue(db: KobeDb, who: MemoryWho) {
  const teamId = workspaceOf(who);
  if (!curates(who, "team"))
    throw notAllowed("Only Team admins and memory stewards review Workspace proposals.");
  return withTeam(db, teamId, async (tx) => {
    const op = await openOp(tx, who, "team");
    const proposals: ProposalCard[] = [];
    for (const p of await pendingProposals(tx, teamId)) proposals.push(await queueCard(tx, op, p));
    return { proposals };
  });
}

export function listMine(db: KobeDb, who: MemoryWho) {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => ({
    proposals: (await proposalsOf(tx, teamId, who.userId)).map((p) => ({
      ...base(p),
      back_in_review: backInReview(p),
      may_repropose: mayRepropose(p),
    })),
  }));
}
