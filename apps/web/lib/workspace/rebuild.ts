/**
 * Rebuilding a workspace whose storage was lost with its server (KOBE-739): the member's own
 * (`/v1/workspace/rebuild`) or, for a team admin, a member's (`/v1/team/workspaces/{id}/rebuild`).
 * `status()` reads whether the volume is lost and when the workspace last synced; `confirm()`
 * rebuilds it (the server re-checks that it is lost first).
 */
import { apiRequest, type ApiResult } from "../api/client";

/**
 * `unreachable`: the server holding the volume is down, not long enough to rebuild yet;
 * `rebuilding`: a confirmed rebuild whose cleanup has not finished (confirming again finishes it).
 */
export type VolumeState = "lost" | "unreachable" | "rebuilding" | "present" | "missing" | "unknown";

export interface RebuildStatus {
  readonly volume: VolumeState;
  /** ISO time of the last sync; null: the workspace never synced. */
  readonly lastSyncedAt: string | null;
  readonly rebuildable: boolean;
  /** `unreachable`: since when the server is down, and when the rebuild will be offered. */
  readonly downSince?: string;
  readonly offerAt?: string;
}

export interface RebuildResult {
  /** `already`: another click (or another admin) rebuilt it first. */
  readonly status: "rebuilt" | "already";
  readonly lastSyncedAt: string | null;
}

export interface RebuildApi {
  status(): Promise<ApiResult<RebuildStatus>>;
  confirm(): Promise<ApiResult<RebuildResult>>;
}

/** The code a run fails with when the member's workspace volume is lost. */
export const VOLUME_LOST_CODE = "workspace_volume_lost";

/**
 * What a rebuild cannot bring back, besides changes after the last sync: what the sync never
 * copies by design (docs/guide/files/storage-limits.md).
 */
export const NEVER_SYNCED =
  ".venv, node_modules and __pycache__ folders, empty folders, and file permissions other than the executable bit";

export function createRebuildApi(
  teamId: string,
  fetchFn?: typeof fetch,
  /** A team admin rebuilding a member's workspace; absent: the caller's own. */
  userId?: string,
): RebuildApi {
  const path =
    userId === undefined
      ? "/v1/workspace/rebuild"
      : `/v1/team/workspaces/${encodeURIComponent(userId)}/rebuild`;
  const opts = { teamId, fetchFn };
  return {
    // Answers are camelized by apiRequest (`last_synced_at` → `lastSyncedAt`).
    status: () => apiRequest<RebuildStatus>(path, opts),
    confirm: () =>
      apiRequest<RebuildResult>(path, { ...opts, method: "POST", json: { confirm: true } }),
  };
}

/** What a rebuild means if the old server ever comes back (review g72: say it plainly). */
export const NODE_MAY_RETURN =
  "If that server comes back later, the changes it held since the last sync are not recovered: the old storage is deleted by the rebuild.";

/** "21 Nov 2026, 10:15" in the viewer's locale; "never" without a sync. */
export function syncTimeText(iso: string | null): string {
  if (iso === null) return "never";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "unknown"
    : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
