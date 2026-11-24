import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { SemanticMemoryKind } from "@kobe/protocol";
import { recordAudit } from "../../../audit/record.js";
import { evaluateMemoryWrite } from "../../checks.js";
import { openOp } from "../../items/context.js";
import { MemoryItemError, invalid, notAllowed, notFound } from "../../items/errors.js";
import { locate } from "../../items/location.js";
import { readItem } from "../../items/rows.js";
import type { MemoryWho } from "../../items/who.js";
import { quotesThePerson } from "../../review/evidence.js";
import { workspaceOf } from "../../review/ids.js";
import { settleWhenDecided } from "../../review/notify.js";
import { allowedScopes, saveShape } from "../../review/rules.js";
import { lockCandidate } from "../../review/stored.js";
import { readSwitches } from "../../switches.js";
import { curatesWorkspace, isTeamAdmin } from "./access.js";
import { noticeAwaitingTeam, noticeConfirmed } from "./notify.js";
import { readSiteProposal } from "./rows.js";
import type { ProposeSiteFromCandidate, ProposeSiteFromItem } from "./schemas.js";
import { workspaceView, type WorkspaceProposalView } from "./views.js";

/**
 * Proposing a Workspace statement to the Site (KOBE-403, SM19/SM20). Two entry points, each one
 * `withTeam()` transaction in the active Workspace:
 *
 * - **Propose → Site** on the caller's own To review candidate: `stated` or `confirmed` only (an
 *   inferred one stays personal), a new memory, the person's own words still in the thread
 *   (`evidence.ts`). The candidate closes as `proposed` with the Site proposal's id on its
 *   (Workspace-side) payload; nothing of it crosses: no evidence, quote, rationale or thread.
 * - **Propose to Site** on an existing Workspace memory: Workspace curators only. The memory stays.
 *
 * Both need the Workspace's **Members may propose to the Site** switch (KOBE-381, on by default;
 * off stops every proposal from that Workspace), a justification, and pass the hard memory checks
 * (length, secrets); lint warnings and Policy conflicts are returned for the proposer to see and
 * travel to the reviewers, who decide. A Team admin's proposal skips step 1 (it is confirmed by
 * them). The 30-day clock starts here (`expires_at`); request-changes rounds never reset it.
 */

export interface SiteProposed {
  readonly proposal: WorkspaceProposalView;
  /** What the shared checks find against Site memory now (codes and ids only). */
  readonly checks: {
    readonly warnings: string[];
    readonly policy_conflicts: { id: string; version: number }[];
  };
}

export const switchedOff = () =>
  new MemoryItemError(
    "memory_disabled",
    "This workspace doesn't propose memories to the Site (Members may propose to the Site is off).",
  );

/** The switch and the shared memory checks on the text that would cross (refuses hard findings). */
export async function checkSiteText(
  tx: KobeTx,
  who: MemoryWho,
  teamId: string,
  text: { statement: string; justification: string },
): Promise<SiteProposed["checks"]> {
  if (!(await readSwitches(tx, teamId)).memory.siteProposals) throw switchedOff();
  const op = await openOp(tx, who, "site");
  const found = await evaluateMemoryWrite(op, {
    scope: "site",
    policy: false,
    statement: text.statement,
    justification: text.justification,
  });
  if (found.invalid !== null) throw invalid(found.invalid);
  if (found.secret !== null)
    throw new MemoryItemError(
      "memory_secret",
      `This looks like ${found.secret.label}. Remove it: secrets can never be saved in memory.`,
    );
  return {
    warnings: found.warnings.map((w) => w.code),
    policy_conflicts: found.policyConflicts.map((c) => ({ id: c.id, version: c.version })),
  };
}

interface NewSiteProposal {
  readonly statement: string;
  readonly kind: SemanticMemoryKind;
  readonly justification: string;
}

async function insertSiteProposal(
  tx: KobeTx,
  teamId: string,
  who: MemoryWho,
  p: NewSiteProposal,
): Promise<{ id: string; confirmed: boolean }> {
  // Step 1 is the Team admin's: a Team admin's own proposal is confirmed by them.
  const confirmed = isTeamAdmin(who);
  const by = confirmed ? who.userId : null;
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO site_memory_proposals
      (from_team_id, statement, kind, justification, proposer_id, state, team_confirmed_by,
       team_confirmed_at)
    VALUES (${teamId}, ${p.statement}, ${p.kind}, ${p.justification}, ${who.userId},
            ${confirmed ? "awaiting_site" : "awaiting_team"}, ${by},
            ${confirmed ? sql`now()` : sql`NULL`})
    RETURNING id`);
  const id = rows[0]?.id;
  if (!id) throw new Error("site memory proposal insert returned nothing");
  return { id, confirmed };
}

async function finish(
  tx: KobeTx,
  teamId: string,
  who: MemoryWho,
  made: { id: string; confirmed: boolean },
  checks: SiteProposed["checks"],
): Promise<SiteProposed> {
  const subject = { id: made.id, fromTeamId: teamId, proposerId: who.userId };
  if (made.confirmed) await noticeConfirmed(tx, subject, who.userId);
  else await noticeAwaitingTeam(tx, subject, who.userId, false);
  const row = await readSiteProposal(tx, { side: "workspace", teamId }, made.id);
  return { proposal: workspaceView(who, row), checks };
}

export function proposeSiteFromCandidate(
  db: KobeDb,
  who: MemoryWho,
  candidateId: string,
  body: ProposeSiteFromCandidate,
): Promise<SiteProposed> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const row = await lockCandidate(tx, { teamId, userId: who.userId }, candidateId);
    const c = row.candidate;
    const kind = body.kind ?? c.kind;
    if (c.source === "inferred")
      throw invalid("Kaiju noticed this one: only what you said or confirmed goes to the Site.");
    if (saveShape(c).op !== "create" || !allowedScopes(c, kind).includes("team"))
      throw invalid("Only a new shared memory can be proposed to the Site.");
    if (!(await quotesThePerson(tx, { teamId, threadId: row.threadId }, c)))
      throw notAllowed("A Site proposal needs your own words in this conversation.");
    const statement = body.statement ?? c.statement;
    const checks = await checkSiteText(tx, who, teamId, {
      statement,
      justification: body.justification,
    });
    const made = await insertSiteProposal(tx, teamId, who, {
      statement,
      kind,
      justification: body.justification,
    });
    // The Workspace-side candidate remembers where it went; the proposal knows nothing of it.
    await tx.execute(sql`
      UPDATE memory_candidates SET state = 'proposed', decided_at = now(),
             payload = (payload - 'returned') || ${JSON.stringify({ site_proposal_id: made.id })}::jsonb
       WHERE team_id = ${teamId} AND id = ${row.id} AND state = 'open'`);
    await settleWhenDecided(tx, teamId, row.passId);
    await recordAudit(tx, {
      action: "memory.site_proposal.created",
      teamId,
      target: {
        proposalId: made.id,
        source: "candidate",
        candidateId: row.id,
        itemId: null,
        confirmed: made.confirmed,
        edited: statement !== c.statement || kind !== c.kind,
      },
    });
    return finish(tx, teamId, who, made, checks);
  });
}

export function proposeSiteFromItem(
  db: KobeDb,
  who: MemoryWho,
  body: ProposeSiteFromItem,
): Promise<SiteProposed> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    if (!curatesWorkspace(who))
      throw notAllowed("Only Team admins and memory stewards propose Workspace memories.");
    const item = await readItem(tx, locate("team", teamId, who.userId), body.item_id);
    if (!item) throw notFound();
    if (item.status !== "active") throw invalid("Only an active memory can be proposed.");
    const statement = body.statement ?? item.statement;
    const kind = body.kind ?? item.kind;
    const checks = await checkSiteText(tx, who, teamId, {
      statement,
      justification: body.justification,
    });
    const made = await insertSiteProposal(tx, teamId, who, {
      statement,
      kind,
      justification: body.justification,
    });
    await recordAudit(tx, {
      action: "memory.site_proposal.created",
      teamId,
      target: {
        proposalId: made.id,
        source: "item",
        candidateId: null,
        itemId: item.id,
        confirmed: made.confirmed,
        edited: statement !== item.statement || kind !== item.kind,
      },
    });
    return finish(tx, teamId, who, made, checks);
  });
}
