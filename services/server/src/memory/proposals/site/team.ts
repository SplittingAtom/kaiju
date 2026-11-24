import { sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { recordAudit } from "../../../audit/record.js";
import { notAllowed } from "../../items/errors.js";
import type { MemoryWho } from "../../items/who.js";
import { workspaceOf } from "../../review/ids.js";
import { assertWorkspaceReads, curatesWorkspace, isTeamAdmin } from "./access.js";
import { noticeConfirmed, settleWithdrawn } from "./notify.js";
import { checkSiteText, type SiteProposed } from "./propose.js";
import { lockOpen, readSiteProposal, type SiteProposalRow } from "./rows.js";
import type { ConfirmSiteProposal } from "./schemas.js";
import { workspaceView, type WorkspaceProposalView } from "./views.js";

/**
 * Step 1 on the Workspace side (KOBE-403, SM19): only a Team admin's confirmation moves a
 * statement and its justification to the Site. Team admins confirm (Edit and confirm: statement,
 * kind, justification; the edit is audited, never the text) and withdraw; the proposer withdraws
 * their own; Workspace curators other than the proposer endorse (a flag the Site sees). Each runs
 * in the Workspace's `withTeam()` transaction with the proposal row-locked.
 */

const ws = (teamId: string) => ({ side: "workspace", teamId }) as const;

async function lockForWorkspace(
  tx: KaijuTx,
  who: MemoryWho,
  teamId: string,
  id: string,
  want?: SiteProposalRow["state"][],
): Promise<SiteProposalRow> {
  // Visibility first, so a proposal the caller can't read is 404 whatever its state.
  assertWorkspaceReads(who, await readSiteProposal(tx, ws(teamId), id));
  return lockOpen(tx, ws(teamId), id, want);
}

export function confirmSiteProposal(
  db: KaijuDb,
  who: MemoryWho,
  id: string,
  body: ConfirmSiteProposal,
): Promise<SiteProposed> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const p = await lockForWorkspace(tx, who, teamId, id, ["awaiting_team"]);
    if (!isTeamAdmin(who))
      throw notAllowed("Only Team admins confirm what this workspace proposes to the Site.");
    const statement = body.statement ?? p.statement;
    const kind = body.kind ?? p.kind;
    const justification = body.justification ?? p.justification;
    const checks = await checkSiteText(tx, who, teamId, { statement, justification });
    await tx.execute(sql`
      UPDATE site_memory_proposals
         SET statement = ${statement}, kind = ${kind}, justification = ${justification},
             state = 'awaiting_site', team_confirmed_by = ${who.userId}, team_confirmed_at = now(),
             updated_at = now()
       WHERE id = ${p.id} AND from_team_id = ${teamId} AND state = 'awaiting_team'`);
    await recordAudit(tx, {
      action: "memory.site_proposal.confirmed",
      teamId,
      target: {
        proposalId: p.id,
        proposerId: p.proposer.id,
        edited: statement !== p.statement || kind !== p.kind || justification !== p.justification,
        round: p.rounds,
      },
    });
    await noticeConfirmed(
      tx,
      { id: p.id, fromTeamId: teamId, proposerId: p.proposer.id },
      who.userId,
    );
    const row = await readSiteProposal(tx, ws(teamId), p.id);
    return { proposal: workspaceView(who, row), checks };
  });
}

export function endorseSiteProposal(
  db: KaijuDb,
  who: MemoryWho,
  id: string,
): Promise<{ readonly proposal: WorkspaceProposalView }> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const p = await lockForWorkspace(tx, who, teamId, id);
    if (!curatesWorkspace(who))
      throw notAllowed("Only Team admins and memory stewards endorse Site proposals.");
    if (p.proposer.id === who.userId)
      throw notAllowed("You can't endorse your own proposal: another curator does.");
    if (!p.endorsed) {
      await tx.execute(sql`
        UPDATE site_memory_proposals SET endorsed = true, updated_at = now()
         WHERE id = ${p.id} AND from_team_id = ${teamId}`);
      await recordAudit(tx, {
        action: "memory.site_proposal.endorsed",
        teamId,
        target: { proposalId: p.id, proposerId: p.proposer.id },
      });
    }
    return { proposal: workspaceView(who, await readSiteProposal(tx, ws(teamId), p.id)) };
  });
}

export function withdrawSiteProposal(
  db: KaijuDb,
  who: MemoryWho,
  id: string,
): Promise<{ readonly proposal: WorkspaceProposalView }> {
  const teamId = workspaceOf(who);
  return withTeam(db, teamId, async (tx) => {
    const p = await lockForWorkspace(tx, who, teamId, id);
    const own = p.proposer.id === who.userId;
    if (!own && !isTeamAdmin(who))
      throw notAllowed("Only the proposer or a Team admin withdraws a Site proposal.");
    await tx.execute(sql`
      UPDATE site_memory_proposals SET state = 'withdrawn', updated_at = now()
       WHERE id = ${p.id} AND from_team_id = ${teamId}`);
    await recordAudit(tx, {
      action: "memory.site_proposal.withdrawn",
      teamId,
      target: {
        proposalId: p.id,
        proposerId: p.proposer.id,
        by: own ? "proposer" : "team_admin",
        fromState: p.state as "awaiting_team" | "awaiting_site",
      },
    });
    await settleWithdrawn(tx, { id: p.id, fromTeamId: teamId, proposerId: p.proposer.id });
    return { proposal: workspaceView(who, await readSiteProposal(tx, ws(teamId), p.id)) };
  });
}
