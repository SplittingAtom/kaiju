import { sql, type KobeTx } from "@kobe/db";
import type { SandboxTarget } from "../sandbox-wire/types.js";

/**
 * Dormant-volume reclaim (KOBE-733, review STO-1). Hibernation keeps a sandbox's claim and its
 * `/workspace` volume, and every volume counts against the team's PVC quota (50 by default), so a
 * team stops at about 48 members who ever used Kobe. When an install turns reclaim on
 * (`sandbox.hibernation.reclaim`, off by default), the hibernation sweep deletes the sandbox and its
 * volume once it has been hibernated for `dormantDays` and its workspace copy in object storage is
 * **proven** complete; the next wake starts a new sandbox whose agent restores the workspace.
 *
 * The proof (`sandboxes.volume_synced_at`) comes only from the agent's shutdown: after every Pi,
 * tool process and kernel is gone, the agent pushes, checks that nothing is local-only, and calls
 * `POST flushed` with its last wire connection. {@link recordFlushProof} accepts it only for the
 * sandbox the session token names, while it is hibernated, when that connection is the one the
 * hibernation closed, and with no upload reserved. Any later upload or manifest change
 * (`clearFlushProof`) and any wake clear it. No proof (a killed pod, an older image, a timeout, a
 * failed push): the volume is kept. Checked again under the row lock before reclaiming: no content
 * marked lost, no command waiting, no legal hold.
 */

export interface ReclaimSettings {
  /** Days a sandbox stays hibernated before its volume may be reclaimed. */
  readonly dormantDays: number;
  /** Most volumes one sweep reclaims per team (spreads Kubernetes deletes). */
  readonly batchPerTeam?: number;
}

/**
 * The agent's shutdown proof (`POST flushed`): sets `volume_synced_at` when the caller's sandbox is
 * the hibernated one, the named connection is the one its hibernation closed, and no upload is
 * reserved. Returns whether it was recorded.
 */
export async function recordFlushProof(
  tx: KobeTx,
  caller: SandboxTarget & { readonly sandboxId: string },
  connectionId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    UPDATE sandboxes s SET volume_synced_at = now()
     WHERE s.team_id = ${caller.teamId} AND s.user_id = ${caller.userId}
       AND s.state = 'hibernated' AND s.sandbox_id = ${caller.sandboxId}
       AND EXISTS (
         SELECT 1 FROM sandbox_connections c
          WHERE c.team_id = ${caller.teamId} AND c.user_id = ${caller.userId}
            AND c.sandbox_id = ${caller.sandboxId} AND c.connection_id = ${connectionId}
            AND c.closed_at = s.state_changed_at)
       AND EXISTS (
         SELECT 1 FROM workspace_sync w
          WHERE w.team_id = ${caller.teamId} AND w.user_id = ${caller.userId}
            AND w.pending_blobs = 0)`);
  return (res.rowCount ?? 0) > 0;
}

/** Any upload or manifest change after the proof: the volume is no longer proven covered. */
export async function clearFlushProof(tx: KobeTx, owner: SandboxTarget): Promise<void> {
  await tx.execute(sql`
    UPDATE sandboxes SET volume_synced_at = NULL
     WHERE team_id = ${owner.teamId} AND user_id = ${owner.userId}
       AND volume_synced_at IS NOT NULL`);
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
       AND volume_synced_at >= state_changed_at
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
