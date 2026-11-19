import { asc, sql, teams, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { logger } from "../logger.js";
import { MEMORY_REMINDER_DAYS, notifyMemoryAll, siteProposalsFrozen } from "./memory.js";

/**
 * Site proposals and the Site's curators (KOBE-653, SM22), a step of the memory reminder pass
 * (one replica at a time under its lock; every write is idempotent, so an overlapping pass changes
 * nothing twice).
 *
 * **Relay.** Notifications and reminders live in a Workspace (`team_id`, the member's bell), and
 * KOBE-403 writes a proposal's notices in the proposing Workspace, so a Site admin or Site steward
 * who is not a member there would hear nothing. For each proposal awaiting the Site, each such
 * curator gets the `memory.site_proposal.confirmed` notice and the reminder in their **home
 * Workspace** instead: the one they last made active if they still belong to it, otherwise their
 * first by id. Once per confirmation round: the reminder row (`memory_reminders_once`, created
 * after the confirmation) is the marker, inserted before the notice and only then the notice is
 * written, in the same transaction. Ids only (no actor: the confirmer is not a member there), and
 * the bell links to the Site console, never to the proposing Workspace. A curator who belongs to
 * no Workspace has no bell; they see the Site queue (ledger KOBE-653).
 *
 * **One reminder per step (KOBE-666, Gate C decision 4).** Each decider of a step gets exactly one
 * reminder, {@link MEMORY_REMINDER_DAYS} days after the step started (the relayed one: after the
 * confirmation, like KOBE-403's own); it is never repeated. The send re-checks the step and drops
 * the row once it is over (`mayDecide`).
 *
 * Nothing runs while a Site-wide legal hold is in force (KOBE-647): reminder rows stay as they are.
 */

// A function: memory.ts imports this module, so its constants are not set yet at load time.
const reminderDelay = () => sql`make_interval(days => ${MEMORY_REMINDER_DAYS})`;
const CONFIRMED = "memory.site_proposal.confirmed";

/** A proposal awaiting the Site (step 2), not past its 30 days. */
interface Open {
  readonly id: string;
  readonly fromTeamId: string;
  readonly proposerId: string;
}

interface Scan {
  /** Curator id → Workspaces they are an active member of. */
  readonly memberships: Map<string, string[]>;
  /** `${curator}:${proposal}` already relayed for the current round, in any Workspace. */
  readonly relayed: Set<string>;
}

export interface RelayCounts {
  readonly relayed: number;
}

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

async function openProposals(db: KobeDb): Promise<Open[]> {
  const { rows } = await db.execute<{ id: string; from_team_id: string; proposer_id: string }>(sql`
    SELECT id, from_team_id, proposer_id FROM site_memory_proposals
     WHERE state = 'awaiting_site' AND expires_at > now()
     ORDER BY id`);
  return rows.map((r) => ({ id: r.id, fromTeamId: r.from_team_id, proposerId: r.proposer_id }));
}

/** Active Site admins (and the owner) and Site memory stewards. */
async function curators(db: KobeDb): Promise<string[]> {
  const { rows } = await db.execute<{ user_id: string }>(sql`
    SELECT r.user_id FROM site_roles r JOIN users u ON u.id = r.user_id AND u.deactivated_at IS NULL
    UNION
    SELECT g.user_id FROM site_grants g JOIN users u ON u.id = g.user_id AND u.deactivated_at IS NULL
     WHERE g."grant" = 'memory_steward'
    ORDER BY user_id`);
  return rows.map((r) => r.user_id);
}

/** One read-only look at every Workspace, each under its own RLS. */
async function scan(db: KobeDb, open: readonly Open[], people: readonly string[]): Promise<Scan> {
  const out: Scan = { memberships: new Map(), relayed: new Set() };
  const all = await db.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
  const site = open.map((p) => p.id);
  for (const { id: teamId } of all) {
    await withTeam(db, teamId, async (tx) => {
      if (people.length > 0) {
        const { rows } = await tx.execute<{ user_id: string }>(sql`
          SELECT tm.user_id FROM team_members tm
            JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
           WHERE tm.team_id = ${teamId} AND tm.user_id IN (${idList(people)})`);
        for (const { user_id } of rows)
          out.memberships.set(user_id, [...(out.memberships.get(user_id) ?? []), teamId]);
      }
      if (site.length > 0) {
        const { rows } = await tx.execute<{ user_id: string; object_id: string }>(sql`
          SELECT r.user_id, r.object_id FROM memory_reminders r
            JOIN site_memory_proposals p ON p.id = r.object_id
           WHERE r.team_id = ${teamId} AND r.related_kind = ${CONFIRMED}
             AND r.object_id IN (${idList(site)}) AND p.from_team_id <> ${teamId}
             AND r.created_at >= p.team_confirmed_at`);
        for (const r of rows) out.relayed.add(`${r.user_id}:${r.object_id}`);
      }
    });
  }
  return out;
}

/** The Workspace the curator last made active if they still belong to it, else their first. */
async function homeOf(
  db: KobeDb,
  userId: string,
  teamIds: readonly string[],
): Promise<string | undefined> {
  const { rows } = await db.execute<{ team_id: string }>(
    sql`SELECT team_id FROM user_last_teams WHERE user_id = ${userId}`,
  );
  const last = rows[0]?.team_id;
  return last && teamIds.includes(last) ? last : [...teamIds].sort()[0];
}

/** Inserts the round's reminder row; true when it is new (then the notice is owed). */
async function claimRound(
  tx: KobeTx,
  teamId: string,
  proposalId: string,
  userId: string,
): Promise<boolean> {
  // An earlier round's row (sent or not) gives way to this round's.
  await tx.execute(sql`
    DELETE FROM memory_reminders r USING site_memory_proposals p
     WHERE r.team_id = ${teamId} AND r.object_id = ${proposalId} AND r.user_id = ${userId}
       AND p.id = r.object_id AND r.created_at < p.team_confirmed_at`);
  const res = await tx.execute(sql`
    INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, due_at)
    SELECT ${teamId}, ${proposalId}, ${CONFIRMED}, ${userId},
           greatest(now(), team_confirmed_at + ${reminderDelay()})
      FROM site_memory_proposals
     WHERE id = ${proposalId} AND state = 'awaiting_site' AND expires_at > now()
    ON CONFLICT DO NOTHING`);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Relays every open Site proposal awaiting the Site to the curators outside its Workspace. Returns
 * what it did (zero while a Site-wide hold is in force).
 */
export async function relaySiteProposals(db: KobeDb): Promise<RelayCounts> {
  if (await siteProposalsFrozen(db)) return { relayed: 0 };
  const open = await openProposals(db);
  if (open.length === 0) return { relayed: 0 };
  const people = await curators(db);
  const seen = await scan(db, open, people);
  // Home Workspace → [curator, proposal] pairs owed a relay.
  const owed = new Map<string, [string, string][]>();
  for (const p of open) {
    for (const c of people) {
      const theirs = seen.memberships.get(c) ?? [];
      if (c === p.proposerId || theirs.length === 0 || theirs.includes(p.fromTeamId)) continue;
      if (seen.relayed.has(`${c}:${p.id}`)) continue;
      const home = await homeOf(db, c, theirs);
      if (home === undefined) continue;
      owed.set(home, [...(owed.get(home) ?? []), [c, p.id]]);
    }
  }
  let relayed = 0;
  for (const teamId of [...owed.keys()].sort()) {
    try {
      relayed += await withTeam(db, teamId, async (tx) => {
        // A Site-wide hold approved since the first look: change nothing.
        if (await siteProposalsFrozen(tx)) return 0;
        const fresh: [string, string][] = [];
        for (const [c, p] of owed.get(teamId) ?? [])
          if (await claimRound(tx, teamId, p, c)) fresh.push([c, p]);
        // Notify last (KOBE-645 contract), all of this Workspace's notices in one call.
        await notifyMemoryAll(
          tx,
          teamId,
          fresh.map(([c, p]) => ({ recipients: [c], notice: { kind: CONFIRMED, objectId: p } })),
        );
        return fresh.length;
      });
    } catch (err) {
      logger.error({ err, team_id: teamId }, "Site proposal relay: team failed");
    }
  }
  return { relayed };
}
