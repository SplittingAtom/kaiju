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
import type { SandboxProvider } from "../sandbox/provider.js";
import type { VolumeHealth } from "../sandbox/volume-loss.js";
import { notifyHintInTx } from "../sandbox-wire/bus.js";

/**
 * Rebuild a workspace whose volume is lost (KOBE-739, review STO-8). Owner decision (Chris,
 * 2026-11-20): member-confirmed, never automatic. When the node holding a workspace volume's only
 * copy is gone (strict-local storage), the wake fails `workspace_volume_lost`; the member, or a
 * team admin for them, sees the last sync time and confirms. The rebuild then deletes the claim
 * without keeping the volume, and the next wake starts a new sandbox on a fresh volume whose agent
 * restores the workspace from object storage (the same path as a wake after a reclaim, KOBE-733).
 *
 * Never offered while the volume is reachable: the loss is re-checked against the cluster inside
 * the transaction that holds the sandbox row's lock and marks the rebuild, so a volume that came
 * back (node rejoined) is never destroyed with unsynced work on it. Idempotent: a second confirm
 * (double click, another replica) waits for the row lock, then finds no volume left and answers
 * `already`. A legal hold does not block it (nothing in object storage is deleted; the lost
 * volume is unreachable anyway) but is recorded in the audit event.
 */

export type RebuildProvider = Pick<SandboxProvider, "volumeHealth" | "discardLostVolume">;

export interface RebuildStatus {
  /** `unknown`: the cluster could not be read (never offered then). */
  readonly volume: VolumeHealth["state"] | "unknown";
  /** When the workspace last pushed to object storage (null: never). */
  readonly lastSyncedAt: Date | null;
  /** Whether the rebuild can be confirmed now (lost, sync on, a sandbox row, not offboarded). */
  readonly rebuildable: boolean;
}

export type RebuildOutcome =
  | { readonly kind: "rebuilt"; readonly lastSyncedAt: Date | null }
  /** No volume left to discard (a rebuild already ran): the next wake starts afresh. */
  | { readonly kind: "already" }
  /** The volume is reachable, or its loss cannot be proven now: nothing done. */
  | { readonly kind: "reachable" }
  /** The member has no sandbox in this team. */
  | { readonly kind: "no_workspace" }
  /** The member's sandbox was offboarded (departed): their retained volume is not rebuilt here. */
  | { readonly kind: "offboarded" };

export interface WorkspaceRebuild {
  /** Set once the sandbox provider exists (index.ts); `sync`: object storage holds workspaces. */
  setProvider(provider: RebuildProvider | undefined, sync: boolean): void;
  /** Whether rebuilds can run at all here (a provider and workspace sync). */
  available(): boolean;
  status(team: TeamRef, userId: string): Promise<RebuildStatus>;
  /** `byAdmin`: a team admin confirmed it for the member (audited as such). */
  rebuild(team: TeamRef, userId: string, byAdmin: boolean): Promise<RebuildOutcome>;
}

export interface WorkspaceRebuildOptions {
  readonly db: KobeDb;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
}

type Row = {
  readonly state: "running" | "hibernated" | "destroyed";
  readonly sandbox_id: string | null;
  readonly last_push_at: Date | string | null;
};

const toDate = (v: Date | string | null | undefined): Date | null =>
  v === null || v === undefined ? null : new Date(v);

export function createWorkspaceRebuild(options: WorkspaceRebuildOptions): WorkspaceRebuild {
  const { db, log } = options;
  let provider: RebuildProvider | undefined;
  let sync = false;

  const readRow = async (
    tx: KobeTx,
    team: TeamRef,
    userId: string,
    lock: boolean,
  ): Promise<Row | undefined> => {
    const res = await tx.execute<Row>(sql`
      SELECT s.state, s.sandbox_id, w.last_push_at
        FROM sandboxes s
        LEFT JOIN workspace_sync w ON w.team_id = s.team_id AND w.user_id = s.user_id
       WHERE s.team_id = ${team.id} AND s.user_id = ${userId}
       ${lock ? sql`FOR UPDATE OF s` : sql``}`);
    return res.rows[0];
  };

  const health = async (team: TeamRef, userId: string): Promise<VolumeHealth | undefined> => {
    if (!provider) return undefined;
    try {
      return await provider.volumeHealth(team, userId);
    } catch (err) {
      log.warn({ err, team_id: team.id }, "workspace volume check failed: not offering a rebuild");
      return undefined;
    }
  };

  return {
    setProvider(next, hasSync) {
      provider = next;
      sync = hasSync;
    },
    available: () => provider !== undefined && sync,

    async status(team, userId) {
      const row = await withTeam(db, team.id, (tx) => readRow(tx, team, userId, false));
      const lastSyncedAt = toDate(row?.last_push_at);
      if (!row || row.state === "destroyed" || !provider || !sync) {
        return { volume: "unknown", lastSyncedAt, rebuildable: false };
      }
      const found = await health(team, userId);
      return {
        volume: found?.state ?? "unknown",
        lastSyncedAt,
        rebuildable: found?.state === "lost",
      };
    },

    async rebuild(team, userId, byAdmin) {
      const current = provider;
      if (!current || !sync) return { kind: "reachable" };
      return withTeam(db, team.id, async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '10s'`));
        await lockLegalHolds(tx);
        const row = await readRow(tx, team, userId, true);
        if (!row) return { kind: "no_workspace" } as const;
        if (row.state === "destroyed") return { kind: "offboarded" } as const;
        // Re-checked against the cluster under the row lock: never on a reachable volume.
        const found = await health(team, userId);
        if (found?.state === "missing") return { kind: "already" } as const;
        if (found?.state !== "lost") return { kind: "reachable" } as const;
        const held = await isUnderLegalHold(tx, team.id, userId);
        const discarded = await current.discardLostVolume(team, userId, found.node);
        // Like a reclaimed volume: hibernated without a sandbox, so the next wake announces
        // "waking", creates a new claim and restores from object storage.
        await tx.execute(sql`
          UPDATE sandboxes
             SET state = 'hibernated', sandbox_id = NULL, pvc = NULL, volume_synced_at = NULL,
                 state_changed_at = now()
           WHERE team_id = ${team.id} AND user_id = ${userId}`);
        // A connection of the lost pod (it can never answer) is closed; its holder drops it.
        const closed = await tx.execute<{ connection_id: string }>(sql`
          UPDATE sandbox_connections SET closed_at = now()
           WHERE team_id = ${team.id} AND user_id = ${userId} AND closed_at IS NULL
          RETURNING connection_id`);
        for (const c of closed.rows) await notifyHintInTx(tx, { kind: "hib", id: c.connection_id });
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '0'`));
        const lastSyncedAt = toDate(row.last_push_at);
        const sandboxId = discarded.sandboxId ?? row.sandbox_id ?? undefined;
        await recordAudit(tx, {
          action: "sandbox.volume_rebuilt",
          actor: currentAuditContext()?.actor ?? SYSTEM_ACTOR,
          teamId: team.id,
          target: {
            ...(sandboxId ? { sandboxId } : {}),
            userId,
            reason: found.reason,
            lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
            legalHold: held,
            byAdmin,
          },
        });
        log.info(
          { team_id: team.id, reason: found.reason, detail: found.detail, by_admin: byAdmin, held },
          "lost workspace volume discarded: the next wake restores from the last sync",
        );
        return { kind: "rebuilt", lastSyncedAt } as const;
      });
    },
  };
}
