/**
 * Memory quality over the shared API client (KOBE-411): item signals and flags, queue health and
 * Learn's pass signals, computed by the server on read (`/v1/memory/quality`, the Workspace side;
 * `/v1/site/memory/quality`, the Site side). Responses arrive camelized. Read only: nothing here
 * changes a memory, and no flag archives one.
 */
import type { ItemKind } from "./items-api";
import { apiRequest, type ApiResult } from "../api/client";

export type QualityFilter = "all" | "check_this" | "unused";
export type QualityLevel = "workspace" | "site";

export interface ItemSignals {
  readonly id: string;
  readonly statement: string;
  readonly kind: ItemKind;
  readonly pinned: boolean;
  readonly policy: boolean;
  readonly runs: number;
  readonly downRuns: number;
  readonly lastReceivedAt: string | null;
  readonly flags: { readonly checkThis: boolean; readonly unused: boolean };
}

export interface ItemSignalsList {
  readonly thresholds: {
    readonly checkMinRuns: number;
    readonly checkDownRatio: number;
    readonly unusedAfterDays: number;
  };
  readonly counts: { readonly all: number; readonly checkThis: number; readonly unused: number };
  readonly items: readonly ItemSignals[];
}

export type QueueName = "workspace_proposals" | "project_suggestions" | "site_proposals";

export interface QueueHealth {
  readonly queue: QueueName;
  readonly pending: number;
  readonly oldestPendingAt: string | null;
  readonly decided: number;
  readonly medianDecisionSeconds: number | null;
}

export interface QueueHealthList {
  readonly windowDays: number;
  readonly queues: readonly QueueHealth[];
}

export interface PassSignals {
  readonly passes: number;
  readonly failed: number;
  readonly shown: number;
  readonly saved: number;
  readonly proposed: number;
  readonly suggested: number;
  readonly dismissed: number;
  readonly expired: number;
  readonly open: number;
  readonly editedBeforeSave: number;
}

export interface WorkspacePassSignals {
  readonly windowDays: number;
  readonly signals: PassSignals;
}

export interface SitePassSignals {
  readonly windowDays: number;
  readonly totals: PassSignals;
  readonly workspaces: readonly (PassSignals & {
    readonly teamId: string;
    readonly name: string;
  })[];
}

export interface QualityApi {
  items(filter: QualityFilter, scope?: "user" | "team"): Promise<ApiResult<ItemSignalsList>>;
  queues(): Promise<ApiResult<QueueHealthList>>;
  passes(): Promise<ApiResult<WorkspacePassSignals | SitePassSignals>>;
}

/**
 * `workspace`: the active Workspace (`teamId` required). `site`: Site curators; `teamId` is sent
 * when there is an active Workspace, as the other Site memory requests do.
 */
export function createQualityApi(
  level: QualityLevel,
  teamId?: string,
  fetchFn?: typeof fetch,
): QualityApi {
  const base = level === "site" ? "/v1/site/memory/quality" : "/v1/memory/quality";
  const get = <T>(path: string) => apiRequest<T>(`${base}${path}`, { teamId, fetchFn });
  return {
    items: (filter, scope) =>
      get(`/items?filter=${filter}${level === "workspace" ? `&scope=${scope ?? "team"}` : ""}`),
    queues: () => get("/queues"),
    passes: () => get("/passes"),
  };
}

/** A duration in seconds as people read it: minutes, hours or days. */
export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

export const isSitePasses = (p: WorkspacePassSignals | SitePassSignals): p is SitePassSignals =>
  "totals" in p;
