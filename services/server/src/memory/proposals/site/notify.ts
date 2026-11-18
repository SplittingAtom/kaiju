import { sql, type KobeTx } from "@kobe/db";
import {
  notifyMemoryAll,
  registerMemoryReminder,
  settleMemoryReminders,
  type MemoryNoticeFor,
} from "../../../notifications/memory.js";

/**
 * Site proposals' notices (KOBE-403, SM22) on KOBE-645's machinery and its Phase C kinds (no new
 * kind, no migration). Always in the proposing Workspace's `withTeam()` transaction and last in
 * it; ids only, never text. The machinery delivers to active members of that Workspace only;
 * Site curators who are not members get the `confirmed` notice and its reminders in their own
 * Workspace from the reminder pass (`notifications/site-proposal-relay.ts`, KOBE-653), which also
 * repeats the reminders weekly while a step waits. Expiry after 30 days (to the proposer and the
 * confirmer) is the retention job's (`retention/site-proposals.ts`).
 *
 * | event                                   | kind                                       | to                              | reminder (7 d) |
 * | --------------------------------------- | ------------------------------------------ | ------------------------------- | -------------- |
 * | proposed, awaiting a Team admin         | `memory.site_proposal.received`            | Team admins (not the proposer)  | Team admins    |
 * | confirmed (or proposed by a Team admin) | `memory.site_proposal.confirmed`           | Site curators; the proposer     | Site curators  |
 * | Site asked for changes                  | `memory.site_proposal.changes_requested`   | Team admins; the proposer       | Team admins    |
 * | approved or merged                      | `memory.site_proposal.accepted`            | the proposer and the confirmer  | settled        |
 * | rejected                                | `memory.site_proposal.dismissed`           | the proposer and the confirmer  | settled        |
 * | withdrawn                               | none                                       |                                 | settled        |
 * | expired (retention, KOBE-653)           | `memory.site_proposal.expired`             | the proposer and the confirmer  | settled        |
 */

export async function teamAdminsOf(tx: KobeTx, teamId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM team_members WHERE team_id = ${teamId} AND role = 'team_admin'
     ORDER BY user_id`);
  return rows.map((r) => r.user_id);
}

/** Site admins (and the owner) and Site memory stewards with active accounts. */
export async function siteCurators(tx: KobeTx): Promise<string[]> {
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    SELECT r.user_id FROM site_roles r JOIN users u ON u.id = r.user_id AND u.deactivated_at IS NULL
    UNION
    SELECT g.user_id FROM site_grants g JOIN users u ON u.id = g.user_id AND u.deactivated_at IS NULL
     WHERE g."grant" = 'memory_steward'
    ORDER BY user_id`);
  return rows.map((r) => r.user_id);
}

const others = (ids: readonly string[], ...not: (string | null)[]) =>
  [...new Set(ids)].filter((id) => !not.includes(id));

interface Subject {
  readonly id: string;
  readonly fromTeamId: string;
  readonly proposerId: string;
}

/** Waiting for the Workspace's Team admins (a new proposal, or the Site sent it back). */
export async function noticeAwaitingTeam(
  tx: KobeTx,
  p: Subject,
  actorId: string,
  returned: boolean,
): Promise<void> {
  const about = returned
    ? ("memory.site_proposal.changes_requested" as const)
    : ("memory.site_proposal.received" as const);
  await settleMemoryReminders(tx, p.fromTeamId, p.id);
  const admins = others(await teamAdminsOf(tx, p.fromTeamId), returned ? null : p.proposerId);
  await registerMemoryReminder(tx, p.fromTeamId, { objectId: p.id, about, recipients: admins });
  const notices: MemoryNoticeFor[] = [
    {
      recipients: returned ? others([...admins, p.proposerId], actorId) : admins,
      notice: { kind: about, objectId: p.id, actorUserId: actorId },
    },
  ];
  await notifyMemoryAll(tx, p.fromTeamId, notices);
}

/** A Team admin confirmed it (or proposed it themselves): the Site's curators decide now. */
export async function noticeConfirmed(tx: KobeTx, p: Subject, confirmerId: string): Promise<void> {
  await settleMemoryReminders(tx, p.fromTeamId, p.id);
  const curators = others(await siteCurators(tx), p.proposerId);
  await registerMemoryReminder(tx, p.fromTeamId, {
    objectId: p.id,
    about: "memory.site_proposal.confirmed",
    recipients: curators,
  });
  await notifyMemoryAll(tx, p.fromTeamId, [
    {
      recipients: others([...curators, p.proposerId], confirmerId),
      notice: { kind: "memory.site_proposal.confirmed", objectId: p.id, actorUserId: confirmerId },
    },
  ]);
}

/** The Site decided: the proposer and the Team admin who confirmed it hear. */
export async function noticeDecided(
  tx: KobeTx,
  p: Subject & { readonly confirmerId: string | null },
  outcome: "accepted" | "dismissed",
  deciderId: string,
): Promise<void> {
  await settleMemoryReminders(tx, p.fromTeamId, p.id);
  await notifyMemoryAll(tx, p.fromTeamId, [
    {
      recipients: others([p.proposerId, ...(p.confirmerId ? [p.confirmerId] : [])], deciderId),
      notice: { kind: `memory.site_proposal.${outcome}`, objectId: p.id, actorUserId: deciderId },
    },
  ]);
}

/** Withdrawn: nobody owes a decision any more. */
export async function settleWithdrawn(tx: KobeTx, p: Subject): Promise<void> {
  await settleMemoryReminders(tx, p.fromTeamId, p.id);
}
