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
 * curator gets the `memory.site_proposal.confirmed` notice and the 7-day reminder in their **home
 * Workspace** instead: the one they last made active if they still belong to it, otherwise their
 * first by id. Once per confirmation round: the reminder row (`memory_reminders_once`, created
 * after the confirmation) is the marker, inserted before the notice and only then the notice is
 * written, in the same transaction. Ids only (no actor: the confirmer is not a member there), and
 * the bell links to the Site console, never to the proposing Workspace. A curator who belongs to
 * no Workspace has no bell; they see the Site queue (ledger KOBE-653).
 *
 * **Weekly windows.** A Site proposal's reminder sent at least {@link MEMORY_REMINDER_DAYS} days
 * ago is owed again while the proposal still waits at that step (`sent_at` cleared, due now), so
 * the deciders hear once per week until the step ends; the send re-checks the step and drops the
 * row once it is over (`mayDecide`). Proposals of a person a legal hold covers are not re-armed.
 *
 * Nothing runs while a Site-wide legal hold is in force (KOBE-647): reminder rows stay as they are.
 */

// A function: memory.ts imports this module, so its constants are not set yet at load time.
const week = () => sql`make_interval(days => ${MEMORY_REMINDER_DAYS})`;
const CONFIRMED = "memory.site_proposal.confirmed";

interface Open {
  readonly id: string;
  readonly fromTeamId: string;
  readonly state: "awaiting_team" | "awaiting_site";
  readonly proposerId: string;
}

interface Scan {
  /** Curator id → Workspaces they are an active member of. */
  readonly memberships: Map<string, string[]>;
  /** Open proposals whose proposer a hold covers (not re-armed). */
  readonly held: Set<string>;
  /** `${curator}:${proposal}` already relayed for the current round, in any Workspace. */
  readonly relayed: Set<string>;
}

export interface RelayCounts {
  readonly relayed: number;
  readonly rearmed: number;
}

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

async function openProposals(db: KobeDb): Promise<Open[]> {
  const { rows } = await db.execute<{
    id: string;
    from_team_id: string;
    state: Open["state"];
    proposer_id: string;
  }>(sql`
    SELECT id, from_team_id, state, proposer_id FROM site_memory_proposals
     WHERE state IN ('awaiting_team', 'awaiting_site') AND expires_at > now()
     ORDER BY id`);
  return rows.map((r) => ({
    id: r.id,
    fromTeamId: r.from_team_id,
    state: r.state,
    proposerId: r.proposer_id,
  }));
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
  const out: Scan = { memberships: new Map(), held: new Set(), relayed: new Set() };
  const all = await db.select({ id: teams.id }).from(teams).orderBy(asc(teams.id));
  const site = open.filter((p) => p.state === "awaiting_site").map((p) => p.id);
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
      const own = open.filter((p) => p.fromTeamId === teamId);
      for (const p of own) {
        const { rows } = await tx.execute<{ held: boolean }>(
          sql`SELECT public.legal_hold_covers(${teamId}, ${p.proposerId}) AS held`,
        );
        if (rows[0]?.held === true) out.held.add(p.id);
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
    SELECT ${teamId}, ${proposalId}, ${CONFIRMED}, ${userId}, now() + ${week()}
     WHERE EXISTS (SELECT 1 FROM site_memory_proposals
                    WHERE id = ${proposalId} AND state = 'awaiting_site' AND expires_at > now())
    ON CONFLICT DO NOTHING`);
  return (res.rowCount ?? 0) > 0;
}

/** Weekly windows: Site proposal reminders sent a week ago, still waiting at that step. */
async function rearm(tx: KobeTx, teamId: string, held: ReadonlySet<string>): Promise<number> {
  const skip = held.size > 0 ? sql`AND p.id NOT IN (${idList([...held])})` : sql``;
  const res = await tx.execute(sql`
    UPDATE memory_reminders r SET sent_at = NULL, due_at = now()
      FROM site_memory_proposals p
     WHERE r.team_id = ${teamId} AND r.object_id = p.id
       AND r.related_kind IN ('memory.site_proposal.received', 'memory.site_proposal.confirmed',
                              'memory.site_proposal.changes_requested')
       AND r.sent_at <= now() - ${week()} AND p.expires_at > now()
       AND p.state = CASE r.related_kind WHEN ${CONFIRMED} THEN 'awaiting_site'
                                         ELSE 'awaiting_team' END
       ${skip}`);
  return res.rowCount ?? 0;
}

/**
 * Relays every open Site proposal awaiting the Site to the curators outside its Workspace and
 * re-arms the weekly reminders. Returns what it did (zeros while a Site-wide hold is in force).
 */
export async function relaySiteProposals(db: KobeDb): Promise<RelayCounts> {
  if (await siteProposalsFrozen(db)) return { relayed: 0, rearmed: 0 };
  const open = await openProposals(db);
  if (open.length === 0) return { relayed: 0, rearmed: 0 };
  const people = await curators(db);
  const seen = await scan(db, open, people);
  // Home Workspace → [curator, proposal] pairs owed a relay.
  const owed = new Map<string, [string, string][]>();
  for (const p of open.filter((x) => x.state === "awaiting_site")) {
    for (const c of people) {
      const theirs = seen.memberships.get(c) ?? [];
      if (c === p.proposerId || theirs.length === 0 || theirs.includes(p.fromTeamId)) continue;
      if (seen.relayed.has(`${c}:${p.id}`)) continue;
      const home = await homeOf(db, c, theirs);
      if (home === undefined) continue;
      owed.set(home, [...(owed.get(home) ?? []), [c, p.id]]);
    }
  }
  const touched = new Set([...owed.keys(), ...open.map((p) => p.fromTeamId)]);
  for (const ts of seen.memberships.values()) for (const t of ts) touched.add(t);
  let relayed = 0;
  let rearmed = 0;
  for (const teamId of [...touched].sort()) {
    try {
      const done = await withTeam(db, teamId, async (tx) => {
        // A Site-wide hold approved since the first look: change nothing.
        if (await siteProposalsFrozen(tx)) return { rearmed: 0, relayed: 0 };
        const n = await rearm(tx, teamId, seen.held);
        const fresh: [string, string][] = [];
        for (const [c, p] of owed.get(teamId) ?? [])
          if (await claimRound(tx, teamId, p, c)) fresh.push([c, p]);
        // Notify last (KOBE-645 contract), all of this Workspace's notices in one call.
        await notifyMemoryAll(
          tx,
          teamId,
          fresh.map(([c, p]) => ({ recipients: [c], notice: { kind: CONFIRMED, objectId: p } })),
        );
        return { rearmed: n, relayed: fresh.length };
      });
      relayed += done.relayed;
      rearmed += done.rearmed;
    } catch (err) {
      logger.error({ err, team_id: teamId }, "Site proposal relay: team failed");
    }
  }
  return { relayed, rearmed };
}
