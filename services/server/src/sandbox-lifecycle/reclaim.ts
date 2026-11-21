import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import type { SandboxTarget } from "../sandbox-wire/types.js";

/**
 * Dormant-volume reclaim (KOBE-733, review STO-1). Hibernation keeps a sandbox's claim and its
 * `/workspace` volume, and every volume counts against the team's PVC quota (50 by default), so a
 * team stops at about 48 members who ever used Kobe. When an install turns reclaim on
 * (`sandbox.hibernation.reclaim`, off by default), the hibernation sweep deletes the sandbox and its
 * volume once it has been hibernated for `dormantDays` and its workspace copy in object storage is
 * **proven** complete; the next wake starts a new sandbox whose agent restores the workspace from
 * that copy (the existing full restore of an empty volume).
 *
 * The proof (`sandboxes.volume_synced_at`, set only by `markHibernated`): right before hibernating,
 * the server asked the sandbox to sync now and it answered complete (capability
 * `workspace_sync_complete`: a fresh look after the push found nothing local only), and nothing
 * happened on the sandbox after the ask. A hibernated sandbox runs nothing, so its volume cannot
 * change afterwards. Checked again here under the row lock: the workspace's upload reservations are
 * all settled, no content is marked lost from storage (`workspace_blobs.lost_at`: only the volume
 * still holds it), no command waits, and no legal hold covers the member. Anything unproven is
 * never reclaimed.
 */

export interface ReclaimSettings {
  /** Days a sandbox stays hibernated before its volume may be reclaimed. */
  readonly dormantDays: number;
  /**
   * Asks the member's running sandbox for a complete sync before it hibernates; true only when it
   * answered complete (`SandboxWire.syncWorkspace(..., { complete: true })` → `synced`).
   */
  readonly proveSync: (target: SandboxTarget) => Promise<boolean>;
  /** Most volumes one sweep reclaims per team (spreads Kubernetes deletes). */
  readonly batchPerTeam?: number;
}

/** The database's clock now (the proof is compared with timestamps the database wrote). */
export async function databaseNow(db: KobeDb): Promise<Date> {
  const res = await db.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  const now = res.rows[0]?.now;
  if (now === undefined) throw new Error("clock_timestamp() returned no row");
  return new Date(now);
}

/** Hibernated sandboxes of a team past the dormancy period with a proof (unlocked read). */
export async function reclaimCandidates(
  tx: KobeTx,
  teamId: string,
  dormantDays: number,
  limit: number,
): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM sandboxes
     WHERE team_id = ${teamId} AND state = 'hibernated' AND sandbox_id IS NOT NULL
       AND volume_synced_at IS NOT NULL
       AND state_changed_at < now() - make_interval(days => ${dormantDays})
     ORDER BY state_changed_at
     LIMIT ${limit}`);
  return res.rows.map((r) => r.user_id);
}

export interface ReclaimableSandbox {
  readonly sandboxId: string;
  readonly pvc: string | null;
}

/**
 * Locks the row (SKIP LOCKED: a wake or another replica holds it) and re-checks that the volume may
 * be reclaimed now. The caller holds the legal-hold lock. Undefined when it may not.
 */
export async function lockReclaimable(
  tx: KobeTx,
  target: SandboxTarget,
  dormantDays: number,
): Promise<ReclaimableSandbox | undefined> {
  const locked = await tx.execute<{ sandbox_id: string; pvc: string | null }>(sql`
    SELECT sandbox_id, pvc FROM sandboxes
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
       AND state = 'hibernated' AND sandbox_id IS NOT NULL AND volume_synced_at IS NOT NULL
       AND volume_synced_at <= state_changed_at
       AND state_changed_at < now() - make_interval(days => ${dormantDays})
     FOR UPDATE SKIP LOCKED`);
  const row = locked.rows[0];
  if (!row) return undefined;
  const res = await tx.execute<{
    settled: boolean;
    lost: boolean;
    held: boolean;
    waiting: boolean;
  }>(
    sql`
    SELECT EXISTS (
             SELECT 1 FROM workspace_sync w
              WHERE w.team_id = ${target.teamId} AND w.user_id = ${target.userId}
                AND w.pending_blobs = 0
           ) AS settled,
           EXISTS (
             SELECT 1 FROM workspace_blobs b
              WHERE b.team_id = ${target.teamId} AND b.user_id = ${target.userId}
                AND b.lost_at IS NOT NULL
           ) AS lost,
           public.legal_hold_covers(${target.teamId}, ${target.userId}) AS held,
           EXISTS (
             SELECT 1 FROM sandbox_commands c
              WHERE c.team_id = ${target.teamId} AND c.user_id = ${target.userId}
                AND c.status IN ('pending', 'delivered')
           ) AS waiting`,
  );
  const check = res.rows[0];
  if (!check?.settled || check.lost || check.held || check.waiting) return undefined;
  return { sandboxId: row.sandbox_id, pvc: row.pvc };
}

/**
 * After the claim and volume are gone: the row stays `hibernated` without a sandbox, so the next
 * wake creates a new one (and announces "waking"); the proof is used up.
 */
export async function forgetReclaimedSandbox(tx: KobeTx, target: SandboxTarget): Promise<void> {
  await tx.execute(sql`
    UPDATE sandboxes SET sandbox_id = NULL, pvc = NULL, volume_synced_at = NULL
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}`);
}
