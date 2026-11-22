import { sql, type KobeTx } from "@kobe/db";
import type { SandboxTarget } from "../sandbox-wire/types.js";
import type { ImmediateLossReason, NodeDownReason, VolumeHealth } from "../sandbox/volume-loss.js";

/**
 * Turns what the cluster says about a workspace volume into a verdict (KOBE-739, review g72 HIGH).
 * A claim `Lost` or a PV missing or `Failed` is lost at once. A missing or not-Ready node can come
 * back with its disk intact (re-join, long upgrade, kubelet down), so it counts as lost only once
 * this server has seen it down continuously for the grace period: the first observation is stored
 * in `sandboxes.volume_lost_since` (server clock only, never a controller timestamp) and any
 * observation that the node is back clears it. Observations happen on wakes, status reads,
 * confirms, and every hibernation sweep for rows already marked (`observeMarkedVolumes`). The
 * period counts only while observed continuously: each observation stores `volume_lost_seen_at`,
 * and a gap of more than {@link OBSERVATION_GAP_MINUTES} restarts the clock (a flapping node or a
 * leftover from an old outage never counts as lost at once).
 */

/** Two "still down" observations further apart than this do not make a continuous period. */
export const OBSERVATION_GAP_MINUTES = 10;

export type VolumeVerdict =
  | {
      readonly state: "lost";
      readonly reason: ImmediateLossReason | NodeDownReason;
      readonly node?: string;
      readonly detail: string;
      /** When the node was first seen down (null for an immediate reason). */
      readonly firstSeenAt: Date | null;
    }
  | {
      /** The node is down, but not for the whole grace period yet: not offered. */
      readonly state: "unreachable";
      readonly reason: NodeDownReason;
      readonly node: string;
      readonly detail: string;
      readonly firstSeenAt: Date;
      /** When the rebuild will be offered if the node stays down. */
      readonly offerAt: Date;
    }
  | { readonly state: "present" }
  | { readonly state: "missing" };

const toDate = (v: Date | string): Date => new Date(v);

/** Records the observation on the member's sandbox row (inside `withTeam`) and judges it. */
export async function observeVolume(
  tx: KobeTx,
  target: SandboxTarget,
  health: VolumeHealth,
  graceMinutes: number,
): Promise<VolumeVerdict> {
  if (health.state === "missing") return health;
  if (health.state === "present") {
    await tx.execute(sql`
      UPDATE sandboxes SET volume_lost_since = NULL, volume_lost_seen_at = NULL
       WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
         AND (volume_lost_since IS NOT NULL OR volume_lost_seen_at IS NOT NULL)`);
    return health;
  }
  if (health.state === "lost") {
    return { state: "lost", reason: health.reason, detail: health.detail, firstSeenAt: null };
  }
  const res = await tx.execute<{ since: Date | string; offer_at: Date | string; aged: boolean }>(
    sql`
    UPDATE sandboxes
       SET volume_lost_since = CASE
             WHEN volume_lost_since IS NULL OR volume_lost_seen_at IS NULL
               OR volume_lost_seen_at < now() - make_interval(mins => ${OBSERVATION_GAP_MINUTES})
             THEN now() ELSE volume_lost_since END,
           volume_lost_seen_at = now()
     WHERE team_id = ${target.teamId} AND user_id = ${target.userId}
    RETURNING volume_lost_since AS since,
              volume_lost_since + make_interval(mins => ${graceMinutes}) AS offer_at,
              now() >= volume_lost_since + make_interval(mins => ${graceMinutes}) AS aged`,
  );
  const row = res.rows[0];
  const now = new Date();
  const firstSeenAt = row ? toDate(row.since) : now;
  const { reason, node, detail } = health;
  if (row?.aged) return { state: "lost", reason, node, detail, firstSeenAt };
  const offerAt = row ? toDate(row.offer_at) : new Date(now.getTime() + graceMinutes * 60_000);
  return { state: "unreachable", reason, node, detail, firstSeenAt, offerAt };
}
