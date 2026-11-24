import { SYSTEM_ACTOR, lockLegalHolds, sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { recordAudit } from "../audit/record.js";
import {
  notifyMemoryAll,
  settleMemoryReminders,
  siteProposalsFrozen,
  type MemoryNoticeFor,
} from "../notifications/memory.js";

/**
 * Expiry of Site memory proposals (v1.3 SMC6, KOBE-653; SM22, SM28), a step of the nightly team
 * pass for the proposing Workspace (one runner across replicas: the retention job's lock; rows are
 * also claimed with SKIP LOCKED). A proposal still open (`awaiting_team`, `awaiting_site`, or
 * `changes_requested`) past `expires_at` (30 days from creation; request-changes rounds never move
 * it, KOBE-403) becomes `expired`: its reminders in the Workspace are settled, the proposer and the
 * Team admin who confirmed it (if any) are told with `memory.site_proposal.expired` (ids only), and
 * the Workspace's audit log gets `memory.site_proposal.decided` with outcome `expired` (system).
 * The state change, the notices and the audit share one transaction, so each is written once.
 * Reminders relayed to Site curators' own Workspaces are dropped at send (the step is over).
 *
 * Holds: nothing changes while a Site-wide legal hold is in force (KOBE-647: it freezes Site
 * memory, proposals included), nor for a proposer a hold covers (`legal_hold_covers`: a hold on the
 * person or on the Workspace, as KOBE-651); they expire after the release.
 */

const BATCH = 200;
const MAX_BATCHES = 1000;

export interface SiteProposalSweepCounts {
  readonly expired: number;
  /** A Site-wide legal hold kept every proposal as it was. */
  readonly frozen: boolean;
}

export const NO_SITE_PROPOSAL_SWEEP: SiteProposalSweepCounts = { expired: 0, frozen: false };

async function expireBatch(tx: KaijuTx, teamId: string): Promise<number> {
  const res = await tx.execute<{
    id: string;
    proposer_id: string;
    team_confirmed_by: string | null;
    rounds: number;
  }>(sql`
    WITH due AS (
      SELECT id FROM site_memory_proposals
       WHERE from_team_id = ${teamId}
         AND state IN ('awaiting_team', 'awaiting_site', 'changes_requested')
         AND expires_at <= now()
         AND NOT public.legal_hold_covers(from_team_id, proposer_id)
       ORDER BY expires_at, id LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED)
    UPDATE site_memory_proposals p SET state = 'expired', updated_at = now()
      FROM due WHERE p.id = due.id
    RETURNING p.id, p.proposer_id, p.team_confirmed_by, p.rounds`);
  for (const r of res.rows) {
    await settleMemoryReminders(tx, teamId, r.id);
    await recordAudit(tx, {
      action: "memory.site_proposal.decided",
      teamId,
      actor: SYSTEM_ACTOR,
      target: {
        proposalId: r.id,
        proposerId: r.proposer_id,
        outcome: "expired",
        round: r.rounds,
        itemId: null,
        version: null,
      },
    });
  }
  // Notify last (KOBE-645 contract); members who left are skipped by the machinery.
  await notifyMemoryAll(
    tx,
    teamId,
    res.rows.map((r): MemoryNoticeFor => ({
      recipients: [r.proposer_id, ...(r.team_confirmed_by ? [r.team_confirmed_by] : [])],
      notice: { kind: "memory.site_proposal.expired", objectId: r.id },
    })),
  );
  return res.rows.length;
}

/** The Workspace's Site proposals past their 30 days, in batches (each its own transaction). */
export async function sweepSiteProposals(
  db: KaijuDb,
  teamId: string,
  options: { readonly stop?: () => boolean } = {},
): Promise<SiteProposalSweepCounts> {
  let expired = 0;
  for (let n = 0; n < MAX_BATCHES && !options.stop?.(); n++) {
    const outcome = await withTeam(db, teamId, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
      await lockLegalHolds(tx);
      if (await siteProposalsFrozen(tx)) return null;
      return expireBatch(tx, teamId);
    });
    if (outcome === null) return { expired, frozen: true };
    expired += outcome;
    if (outcome < BATCH) break;
  }
  return { expired, frozen: false };
}
