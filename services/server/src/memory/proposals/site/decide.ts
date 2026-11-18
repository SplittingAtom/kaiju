import {
  SITE_MEMORY_PROPOSAL_ROUNDS_MAX,
  SYSTEM_ACTOR,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { createSemanticMemoryItemSchema, type SemanticMemoryItemDetail } from "@kobe/protocol";
import { siteMemoryWriteAllows } from "../../../authz/permissions.js";
import { recordAudit } from "../../../audit/record.js";
import { openOp, type Op } from "../../items/context.js";
import { createItemIn } from "../../items/create.js";
import { patchItemIn } from "../../items/edit.js";
import { inactive, invalid, notAllowed, notFound } from "../../items/errors.js";
import { deliverSiteNotices } from "../../items/limits.js";
import type { MemoryWho } from "../../items/who.js";
import { readSwitches } from "../../switches.js";
import { assertSiteDecider, decidesForSite } from "./access.js";
import { switchedOff } from "./propose.js";
import { noticeAwaitingTeam, noticeDecided } from "./notify.js";
import { lockOpen, readSiteProposal, siteProposalNotFound, type SiteProposalRow } from "./rows.js";
import type { ApproveSiteProposal, MergeSiteProposal } from "./schemas.js";
import { siteView, type SiteProposalView } from "./views.js";

/**
 * Step 2 on the Site side (KOBE-403, SM19/SM20): Site admins and Site memory stewards decide a
 * proposal a Team admin confirmed, never their own. Approve creates a Site memory; Merge into an
 * existing Site memory adds its next version (an update); either writes through the item store
 * (switches, rights, limits, the shared memory checks with their audited overrides) as the Site
 * curator, and the version's only provenance is the proposal (`actor_kind = 'proposal'`,
 * `proposal_id`): no evidence, quote or thread link. The Workspace's source memory or candidate
 * is never touched (ac-3). Reject needs a reason; Request changes (a note ≤ 500) sends it back to
 * the Workspace's Team admins and counts a round; after {@link SITE_MEMORY_PROPOSAL_ROUNDS_MAX}
 * rounds it must be decided. Each runs in the proposing Workspace's `withTeam()` transaction
 * (its notices are that Workspace's) with the proposal row-locked; Site rows are site-wide.
 */

const SITE = { side: "site" } as const;

interface Decided<T> {
  readonly value: T;
  readonly pending: Op["pending"];
}

/** Runs a decision on an awaiting_site proposal; Site curators only, others get 404. */
async function decide<T>(
  db: KobeDb,
  who: MemoryWho,
  id: string,
  fn: (tx: KobeTx, p: SiteProposalRow) => Promise<Decided<T>>,
): Promise<T> {
  if (!decidesForSite(who)) throw siteProposalNotFound();
  const { rows } = await db.execute<{ from_team_id: string }>(sql`
    SELECT from_team_id FROM site_memory_proposals
     WHERE id = ${id} AND team_confirmed_by IS NOT NULL`);
  const teamId = rows[0]?.from_team_id;
  if (!teamId) throw siteProposalNotFound();
  const done = await withTeam(db, teamId, async (tx) => {
    const p = await lockOpen(tx, SITE, id, ["awaiting_site"]);
    assertSiteDecider(who, p);
    return fn(tx, p);
  });
  if (done.pending.length > 0) await deliverSiteNotices(db, done.pending);
  return done.value;
}

/**
 * The item store's op for a Site write made from this proposal. The Workspace's **Members may
 * propose to the Site** switch is read again: turned off after confirmation, nothing of that
 * Workspace enters Site memory (approve and merge refuse, `memory_disabled`); reject and request
 * changes still settle the proposal.
 */
async function proposalOp(tx: KobeTx, who: MemoryWho, p: SiteProposalRow): Promise<Op> {
  if (!(await readSwitches(tx, p.fromTeamId)).memory.siteProposals) throw switchedOff();
  return { ...(await openOp(tx, who, "site")), fromProposal: p.id };
}

type Outcome = "approved" | "merged" | "rejected" | "changes_requested";

/**
 * The Workspace's own record of a Site decision (ids only, recorded as the system: the deciding
 * Site curator is named in the site log's paired event, contract wall M6).
 */
async function workspaceAudit(
  tx: KobeTx,
  p: SiteProposalRow,
  outcome: Outcome,
  round: number,
  item: { id: string; version: number } | null = null,
): Promise<void> {
  await recordAudit(tx, {
    action: "memory.site_proposal.decided",
    teamId: p.fromTeamId,
    actor: SYSTEM_ACTOR,
    target: {
      proposalId: p.id,
      proposerId: p.proposer.id,
      outcome,
      round,
      itemId: item?.id ?? null,
      version: item?.version ?? null,
    },
  });
}

async function setDecided(
  tx: KobeTx,
  p: SiteProposalRow,
  who: MemoryWho,
  state: "approved" | "merged" | "rejected",
  extra: { reason?: string; mergedInto?: string } = {},
): Promise<void> {
  await tx.execute(sql`
    UPDATE site_memory_proposals
       SET state = ${state}, decided_by = ${who.userId}, decided_at = now(),
           reason = ${extra.reason ?? null},
           merged_into = ${extra.mergedInto ?? null}, updated_at = now()
     WHERE id = ${p.id} AND state = 'awaiting_site'`);
}

const subject = (p: SiteProposalRow) => ({
  id: p.id,
  fromTeamId: p.fromTeamId,
  proposerId: p.proposer.id,
  confirmerId: p.confirmedBy?.id ?? null,
});

export interface SiteDecision {
  readonly proposal: SiteProposalView;
  readonly item: SemanticMemoryItemDetail;
}

async function accepted(
  tx: KobeTx,
  who: MemoryWho,
  p: SiteProposalRow,
  op: Op,
  item: SemanticMemoryItemDetail,
  outcome: "approved" | "merged",
  edited: boolean,
): Promise<Decided<SiteDecision>> {
  await setDecided(tx, p, who, outcome, outcome === "merged" ? { mergedInto: item.id } : {});
  await recordAudit(tx, {
    action: "memory.site_proposal.accepted",
    teamId: null,
    target: {
      proposalId: p.id,
      fromTeamId: p.fromTeamId,
      proposerId: p.proposer.id,
      outcome,
      itemId: item.id,
      version: item.version,
      edited,
    },
  });
  await workspaceAudit(tx, p, outcome, p.rounds, item);
  await noticeDecided(tx, subject(p), "accepted", who.userId);
  const proposal = siteView(await readSiteProposal(tx, SITE, p.id));
  return { value: { proposal, item }, pending: op.pending };
}

export function approveSiteProposal(
  db: KobeDb,
  who: MemoryWho,
  id: string,
  body: ApproveSiteProposal,
): Promise<SiteDecision> {
  return decide(db, who, id, async (tx, p) => {
    const policyField = body.policy !== undefined;
    if (!siteMemoryWriteAllows(who, { via: "proposal", policyField, targetIsPolicy: false }))
      throw notAllowed("Only Site admins set or change Policy.");
    const statement = body.statement ?? p.statement;
    const kind = body.kind ?? p.kind;
    const parsed = createSemanticMemoryItemSchema.safeParse({
      scope: "site",
      kind,
      statement,
      ...(policyField ? { policy: body.policy } : {}),
      ...(body.overrides ? { overrides: body.overrides } : {}),
    });
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Invalid memory.");
    const op = await proposalOp(tx, who, p);
    const item = await createItemIn(op, parsed.data);
    const edited = statement !== p.statement || kind !== p.kind;
    return accepted(tx, who, p, op, item, "approved", edited);
  });
}

export function mergeSiteProposal(
  db: KobeDb,
  who: MemoryWho,
  id: string,
  body: MergeSiteProposal,
): Promise<SiteDecision> {
  return decide(db, who, id, async (tx, p) => {
    const op = await proposalOp(tx, who, p);
    const statement = body.statement ?? p.statement;
    const before = await readCurrent(tx, body.item_id);
    if (before === null) throw notFound();
    if (before.statement === statement)
      throw invalid(
        "That Site memory already says this: reject the proposal as a duplicate, or change the wording.",
      );
    const item = await patchItemIn(op, body.item_id, {
      statement,
      expected_version: body.expected_version ?? before.version,
      ...(body.overrides ? { overrides: body.overrides } : {}),
    });
    return accepted(tx, who, p, op, item, "merged", statement !== p.statement);
  });
}

async function readCurrent(
  tx: KobeTx,
  itemId: string,
): Promise<{ statement: string; version: number } | null> {
  const { rows } = await tx.execute<{ statement: string; version: number }>(sql`
    SELECT v.statement, i.current_version AS version FROM site_memory_items i
      JOIN site_memory_item_versions v ON v.item_id = i.id AND v.version = i.current_version
     WHERE i.id = ${itemId}`);
  return rows[0] ?? null;
}

export function rejectSiteProposal(
  db: KobeDb,
  who: MemoryWho,
  id: string,
  reason: string,
): Promise<{ readonly proposal: SiteProposalView }> {
  return decide(db, who, id, async (tx, p) => {
    await setDecided(tx, p, who, "rejected", { reason });
    await recordAudit(tx, {
      action: "memory.site_proposal.dismissed",
      teamId: null,
      target: {
        proposalId: p.id,
        fromTeamId: p.fromTeamId,
        proposerId: p.proposer.id,
        outcome: "rejected",
        round: p.rounds,
      },
    });
    await workspaceAudit(tx, p, "rejected", p.rounds);
    await noticeDecided(tx, subject(p), "dismissed", who.userId);
    return { value: { proposal: siteView(await readSiteProposal(tx, SITE, p.id)) }, pending: [] };
  });
}

/**
 * Back to the Workspace's Team admins with a note (step 1 again: they confirm, edited or not).
 * Refused once the proposal has had {@link SITE_MEMORY_PROPOSAL_ROUNDS_MAX} rounds: decide it.
 */
export function requestSiteChanges(
  db: KobeDb,
  who: MemoryWho,
  id: string,
  note: string,
): Promise<{ readonly proposal: SiteProposalView }> {
  return decide(db, who, id, async (tx, p) => {
    if (p.rounds >= SITE_MEMORY_PROPOSAL_ROUNDS_MAX)
      throw inactive(
        `This proposal has had ${SITE_MEMORY_PROPOSAL_ROUNDS_MAX} rounds of changes: approve, merge or reject it.`,
      );
    const round = p.rounds + 1;
    await tx.execute(sql`
      UPDATE site_memory_proposals
         SET state = 'awaiting_team', rounds = ${round}, reason = ${note},
             decided_by = ${who.userId}, decided_at = now(), updated_at = now()
       WHERE id = ${p.id} AND state = 'awaiting_site'`);
    await recordAudit(tx, {
      action: "memory.site_proposal.dismissed",
      teamId: null,
      target: {
        proposalId: p.id,
        fromTeamId: p.fromTeamId,
        proposerId: p.proposer.id,
        outcome: "changes_requested",
        round,
      },
    });
    await workspaceAudit(tx, p, "changes_requested", round);
    await noticeAwaitingTeam(tx, subject(p), who.userId, true);
    return { value: { proposal: siteView(await readSiteProposal(tx, SITE, p.id)) }, pending: [] };
  });
}
