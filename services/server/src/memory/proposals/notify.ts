import { sql, type KobeTx } from "@kobe/db";
import {
  notifyMemory,
  registerMemoryReminder,
  settleMemoryReminders,
} from "../../notifications/memory.js";

/**
 * Workspace proposals' notices (KOBE-397 on KOBE-645's machinery, SM22): a new proposal tells
 * every curator (Team admins + memory stewards, the proposer excluded) and owes each one reminder
 * after 7 days; a decision settles the reminders and tells the proposer the outcome. More than
 * five of one kind an hour roll into the digest (the machinery's rule). Ids only, never text.
 */

/** The Workspace's curators: Team admins and memory stewards (KOBE-380). */
export async function curatorsOf(tx: KobeTx, teamId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM team_members WHERE team_id = ${teamId} AND role = 'team_admin'
    UNION
    SELECT user_id FROM memory_stewards WHERE team_id = ${teamId}
    ORDER BY user_id`);
  return rows.map((r) => r.user_id);
}

/** A proposal was made (or made again): curators are told and owed a reminder. Call last. */
export async function noticeProposed(
  tx: KobeTx,
  teamId: string,
  proposal: { id: string; proposerId: string },
): Promise<void> {
  const recipients = (await curatorsOf(tx, teamId)).filter((u) => u !== proposal.proposerId);
  await registerMemoryReminder(tx, teamId, {
    objectId: proposal.id,
    about: "memory.proposal.received",
    recipients,
  });
  await notifyMemory(tx, teamId, recipients, {
    kind: "memory.proposal.received",
    objectId: proposal.id,
    actorUserId: proposal.proposerId,
  });
}

export type ProposalOutcome = "accepted" | "dismissed" | "changes_requested";

/** A curator decided: no reminder is owed any more and the proposer hears. Call last. */
export async function noticeDecided(
  tx: KobeTx,
  teamId: string,
  proposal: { id: string; proposerId: string },
  outcome: ProposalOutcome,
  curatorId: string,
): Promise<void> {
  await settleMemoryReminders(tx, teamId, proposal.id);
  await notifyMemory(tx, teamId, [proposal.proposerId], {
    kind: `memory.proposal.${outcome}`,
    objectId: proposal.id,
    actorUserId: curatorId,
  });
}
