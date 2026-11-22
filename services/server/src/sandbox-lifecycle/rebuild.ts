import {
  SYSTEM_ACTOR,
  isUnderLegalHold,
  lockLegalHolds,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";
import { currentAuditContext } from "../audit/context.js";
import { recordAudit } from "../audit/record.js";
import type { TeamRef } from "../sandbox/manifests.js";
import type { DiscardGuard, SandboxProvider } from "../sandbox/provider.js";
import type { SandboxTarget } from "../sandbox-wire/types.js";
import { notifyHintInTx } from "../sandbox-wire/bus.js";
import { observeVolume, type VolumeVerdict } from "./volume-verdict.js";

/**
 * Rebuild a workspace whose volume is lost (KOBE-739, review STO-8). Owner decision (Chris,
 * 2026-11-20): member-confirmed, never automatic. When the volume's only copy is lost (claim Lost,
 * PV missing or Failed, or its one node down for the whole grace period, `volume-verdict.ts`) the
 * wake fails `workspace_volume_lost`; the member, or a team admin for them, sees the last sync
 * time and confirms. The old claim and volume are then deleted, and the next wake starts a new
 * sandbox on a fresh volume whose agent restores the workspace from object storage (the path of a
 * wake after a reclaim, KOBE-733). If the node comes back later, what it held since the last sync
 * is gone: the old volume is deleted with its claim (the member is told so before confirming).
 *
 * A resumable state machine (review g72 MEDIUM): the confirm re-checks the verdict live under the
 * sandbox row lock, then marks `rebuild_started_at` and writes the audit event in the same
 * transaction, and commits BEFORE any Kubernetes delete. The cluster work and the row reset come
 * after; when the cluster work fails, the next confirm or the hibernation sweep
 * ({@link completeRebuild}) finishes it (deletes are idempotent). Wakes wait while it is marked.
 * A legal hold does not block it (object storage is untouched) but is recorded in the audit.
 */

export type RebuildProvider = Pick<SandboxProvider, "volumeHealth" | "discardLostVolume">;

export interface RebuildStatus {
  /** `rebuilding`: confirmed, cleanup not finished; `unknown`: the cluster could not be read. */
  readonly volume: VolumeVerdict["state"] | "rebuilding" | "unknown";
  /** When the workspace last pushed to object storage (null: never). */
  readonly lastSyncedAt: Date | null;
  /** Whether the rebuild can be confirmed now. */
  readonly rebuildable: boolean;
  /** `unreachable`: when the node was first seen down, and when the rebuild will be offered. */
  readonly downSince?: Date;
  readonly offerAt?: Date;
}

export type RebuildOutcome =
  | { readonly kind: "rebuilt"; readonly lastSyncedAt: Date | null }
  /** Nothing left to do (another click or the sweep finished it). */
  | { readonly kind: "already" }
  /** The sandbox there now is not the one the rebuild was confirmed for: nothing deleted. */
  | { readonly kind: "superseded" }
  /** Confirmed and audited, but the old claim or volume could not be deleted yet: retried. */
  | { readonly kind: "pending" }
  /** The volume is reachable, or its loss cannot be proven now: nothing done. */
  | { readonly kind: "reachable" }
  /** The node is down but not for the whole grace period yet. */
  | { readonly kind: "not_yet"; readonly offerAt: Date }
  | { readonly kind: "no_workspace" }
  | { readonly kind: "offboarded" };

export interface RebuildSettings {
  /** `sandbox.volumeLoss.graceMinutes`: how long a node must stay down before a rebuild. */
  readonly graceMinutes: number;
}

export interface WorkspaceRebuild {
  /** Set once the sandbox provider exists (index.ts); `sync`: object storage holds workspaces. */
  setProvider(
    provider: RebuildProvider | undefined,
    sync: boolean,
    settings?: RebuildSettings,
  ): void;
  /** Whether rebuilds can run at all here (a provider and workspace sync). */
  available(): boolean;
  /** Cached for {@link STATUS_CACHE_MS} per member (the confirm always re-checks live). */
  status(team: TeamRef, userId: string): Promise<RebuildStatus>;
  /** `byAdmin`: a team admin confirmed it for the member (audited as such). */
  rebuild(team: TeamRef, userId: string, byAdmin: boolean): Promise<RebuildOutcome>;
}

export interface WorkspaceRebuildOptions {
  readonly db: KobeDb;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly now?: () => number;
}

/** How long a status answer is reused for the same member (GET only). */
export const STATUS_CACHE_MS = 30_000;
const DEFAULT_GRACE_MINUTES = 30;

type Row = {
  readonly state: "running" | "hibernated" | "destroyed";
  readonly sandbox_id: string | null;
  readonly rebuild_started_at: Date | string | null;
  readonly last_push_at: Date | string | null;
};

const toDate = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : new Date(v);

async function readRow(tx: KobeTx, target: SandboxTarget, lock: boolean): Promise<Row | undefined> {
  const res = await tx.execute<Row>(sql`
    SELECT s.state, s.sandbox_id, s.rebuild_started_at, w.last_push_at
      FROM sandboxes s
      LEFT JOIN workspace_sync w ON w.team_id = s.team_id AND w.user_id = s.user_id
     WHERE s.team_id = ${target.teamId} AND s.user_id = ${target.userId}
     ${lock ? sql`FOR UPDATE OF s` : sql``}`);
  return res.rows[0];
}

/** How long the cluster deletes may hold the row lock; on timeout the sweep retries later. */
export const DISCARD_TIMEOUT_MS = 30_000;

/**
 * Bounds the cluster work: on timeout the race rejects AND the signal aborts, so the discard's
 * remaining deletes and retries stop (review g72-3); deletes already sent carry a UID precondition.
 */
const withTimeout = <T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`cluster cleanup timed out after ${ms} ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
};

/**
 * The second half of a confirmed rebuild (review g72-2 HIGH): under the sandbox row's lock, held
 * from the re-check through the cluster deletes and the reset, so no other replica or sweep can
 * start a discard after this one reset the row and the member woke a fresh sandbox (`beginWake`
 * waits on the same lock). Re-checks `rebuild_started_at` under the lock; the discard is told the
 * claim UID and the time the rebuild was marked and refuses any claim or volume newer than that.
 * The deletes are bounded ({@link DISCARD_TIMEOUT_MS}); on a failure or timeout the transaction
 * rolls back, `rebuild_started_at` stays set (it was committed by the confirm) and the next
 * confirm or sweep retries. `pending` then.
 */
export async function completeRebuild(
  db: KobeDb,
  provider: Pick<RebuildProvider, "discardLostVolume">,
  team: TeamRef,
  userId: string,
  log: Pick<Logger, "warn" | "error">,
  timeoutMs: number = DISCARD_TIMEOUT_MS,
): Promise<"rebuilt" | "already" | "pending" | "superseded"> {
  try {
    return await withTeam(db, team.id, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '10s'`));
      const locked = await tx.execute<{
        sandbox_id: string | null;
        rebuild_started_at: Date | string | null;
      }>(sql`
        SELECT sandbox_id, rebuild_started_at FROM sandboxes
         WHERE team_id = ${team.id} AND user_id = ${userId} FOR UPDATE`);
      const row = locked.rows[0];
      if (!row || row.rebuild_started_at === null) return "already";
      const guard: DiscardGuard = {
        claimUid: row.sandbox_id,
        notCreatedAfter: new Date(row.rebuild_started_at),
      };
      const discarded = await withTimeout(
        (signal) => provider.discardLostVolume(team, userId, guard, signal),
        timeoutMs,
      );
      if (discarded.refused) {
        // A claim or volume newer than the confirmed rebuild, or one replaced under the same name
        // while we deleted: never deleted. The rebuild ends here, audited; nothing else changes.
        log.error(
          { team_id: team.id, reason: discarded.refused },
          "rebuild: the current claim or volume is not the one the rebuild was confirmed for",
        );
        await tx.execute(sql`
          UPDATE sandboxes SET rebuild_started_at = NULL
           WHERE team_id = ${team.id} AND user_id = ${userId}`);
        await recordAudit(tx, {
          action: "sandbox.volume_rebuild_refused",
          actor: SYSTEM_ACTOR,
          teamId: team.id,
          target: { userId, reason: discarded.refused },
        });
        return "superseded";
      }
      await tx.execute(sql`
        UPDATE sandboxes
           SET state = 'hibernated', sandbox_id = NULL, pvc = NULL, volume_synced_at = NULL,
               volume_lost_since = NULL, volume_lost_seen_at = NULL, rebuild_started_at = NULL,
               state_changed_at = now()
         WHERE team_id = ${team.id} AND user_id = ${userId}`);
      // A connection of the lost pod (it can never answer) is closed; its holder drops it.
      const closed = await tx.execute<{ connection_id: string }>(sql`
        UPDATE sandbox_connections SET closed_at = now()
         WHERE team_id = ${team.id} AND user_id = ${userId} AND closed_at IS NULL
        RETURNING connection_id`);
      for (const c of closed.rows) await notifyHintInTx(tx, { kind: "hib", id: c.connection_id });
      return "rebuilt";
    });
  } catch (err) {
    log.warn({ err, team_id: team.id }, "rebuild: old claim or volume not deleted yet; retried");
    return "pending";
  }
}

/** Rebuilds of a team confirmed over a minute ago and not finished (the sweep completes them). */
export async function unfinishedRebuilds(tx: KobeTx, teamId: string): Promise<string[]> {
  const res = await tx.execute<{ user_id: string }>(sql`
    SELECT user_id FROM sandboxes
     WHERE team_id = ${teamId} AND rebuild_started_at < now() - interval '1 minute'
     LIMIT 10`);
  return res.rows.map((r) => r.user_id);
}

export function createWorkspaceRebuild(options: WorkspaceRebuildOptions): WorkspaceRebuild {
  const { db, log } = options;
  const now = options.now ?? Date.now;
  let provider: RebuildProvider | undefined;
  let sync = false;
  let graceMinutes = DEFAULT_GRACE_MINUTES;
  const cache = new Map<string, { readonly at: number; readonly status: RebuildStatus }>();

  /** The cluster's answer, judged and recorded; undefined when it could not be read. */
  const judge = async (tx: KobeTx, team: TeamRef, userId: string) => {
    if (!provider) return undefined;
    try {
      const health = await provider.volumeHealth(team, userId);
      return await observeVolume(tx, { teamId: team.id, userId }, health, graceMinutes);
    } catch (err) {
      log.warn({ err, team_id: team.id }, "workspace volume check failed: not offering a rebuild");
      return undefined;
    }
  };

  const liveStatus = async (team: TeamRef, userId: string): Promise<RebuildStatus> =>
    withTeam(db, team.id, async (tx) => {
      const row = await readRow(tx, { teamId: team.id, userId }, false);
      const lastSyncedAt = toDate(row?.last_push_at);
      if (!row || row.state === "destroyed" || !provider || !sync) {
        return { volume: "unknown", lastSyncedAt, rebuildable: false };
      }
      if (row.rebuild_started_at !== null) {
        return { volume: "rebuilding", lastSyncedAt, rebuildable: true };
      }
      const verdict = await judge(tx, team, userId);
      if (verdict?.state === "unreachable") {
        return {
          volume: "unreachable",
          lastSyncedAt,
          rebuildable: false,
          downSince: verdict.firstSeenAt,
          offerAt: verdict.offerAt,
        };
      }
      return {
        volume: verdict?.state ?? "unknown",
        lastSyncedAt,
        rebuildable: verdict?.state === "lost",
      };
    });

  /** The confirm's transaction: re-checked live under the lock, then marked and audited. */
  const begin = (team: TeamRef, userId: string, byAdmin: boolean) =>
    withTeam(db, team.id, async (tx): Promise<RebuildOutcome | "proceed"> => {
      const target = { teamId: team.id, userId };
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '10s'`));
      await lockLegalHolds(tx);
      const row = await readRow(tx, target, true);
      if (!row) return { kind: "no_workspace" };
      if (row.state === "destroyed") return { kind: "offboarded" };
      // Confirmed and audited earlier, cleanup unfinished: finish it (no second audit).
      if (row.rebuild_started_at !== null) return "proceed";
      const verdict = await judge(tx, team, userId);
      if (verdict?.state === "missing") return { kind: "already" };
      if (verdict?.state === "unreachable") return { kind: "not_yet", offerAt: verdict.offerAt };
      if (verdict?.state !== "lost") return { kind: "reachable" };
      await tx.execute(sql`
        UPDATE sandboxes SET rebuild_started_at = now()
         WHERE team_id = ${team.id} AND user_id = ${userId}`);
      const held = await isUnderLegalHold(tx, team.id, userId);
      const lastSyncedAt = toDate(row.last_push_at);
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '0'`));
      await recordAudit(tx, {
        action: "sandbox.volume_rebuilt",
        actor: currentAuditContext()?.actor ?? SYSTEM_ACTOR,
        teamId: team.id,
        target: {
          ...(row.sandbox_id ? { sandboxId: row.sandbox_id } : {}),
          userId,
          reason: verdict.reason,
          ...(verdict.node ? { node: verdict.node } : {}),
          firstSeenAt: verdict.firstSeenAt?.toISOString() ?? null,
          lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
          legalHold: held,
          byAdmin,
        },
      });
      log.info(
        { team_id: team.id, reason: verdict.reason, detail: verdict.detail, by_admin: byAdmin },
        "lost workspace volume: rebuild confirmed",
      );
      return "proceed";
    });

  return {
    setProvider(next, hasSync, settings) {
      provider = next;
      sync = hasSync;
      graceMinutes = settings?.graceMinutes ?? DEFAULT_GRACE_MINUTES;
      cache.clear();
    },
    available: () => provider !== undefined && sync,

    async status(team, userId) {
      const key = `${team.id}:${userId}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < STATUS_CACHE_MS) return hit.status;
      const status = await liveStatus(team, userId);
      cache.set(key, { at: now(), status });
      if (cache.size > 10_000) cache.clear();
      return status;
    },

    async rebuild(team, userId, byAdmin) {
      const current = provider;
      if (!current || !sync) return { kind: "reachable" };
      const started = await begin(team, userId, byAdmin);
      if (started !== "proceed") return started;
      cache.delete(`${team.id}:${userId}`);
      const lastSyncedAt = await withTeam(db, team.id, async (tx) =>
        toDate((await readRow(tx, { teamId: team.id, userId }, false))?.last_push_at),
      );
      const done = await completeRebuild(db, current, team, userId, log);
      if (done === "pending") return { kind: "pending" };
      if (done === "superseded") return { kind: "superseded" };
      return done === "rebuilt" ? { kind: "rebuilt", lastSyncedAt } : { kind: "already" };
    },
  };
}
