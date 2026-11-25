/**
 * Site console › Settings › Memory (`/v1/memory/settings?level=site`; site.settings.manage;
 * KOBE-155, widened by KOBE-381): the Site memory switches and the Site memory settings.
 */
import { apiRequest, type ApiResult } from "../../../api/client";
import { snakeBody, type MemorySwitches } from "../team/memory";

export interface SiteMemorySettingsDoc {
  readonly learningModelAlias: string | null;
  /**
   * The embedding model for search by meaning (KOBE-409): a gateway model id
   * (`<gateway provider>/<model>`, e.g. `kaiju-local/nomic-embed-text`), not a catalog alias.
   */
  readonly embeddingModel: string | null;
  /** 4 to 16 KiB. */
  readonly contextBudgetKib: number;
  readonly scopeLimits: {
    readonly user: number;
    readonly portable: number;
    readonly team: number;
    readonly site: number;
  };
  readonly versionCap: number;
  readonly staleAfterDays: number;
  /** "Not used lately" on the Quality tabs (KOBE-411): no run received a memory for this long. */
  readonly unusedAfterDays: number;
  readonly rateLimits: { readonly learnPassesPerHour: number; readonly savesPerMinute: number };
  readonly retentionDays: number;
  /** Where the per-message memories reach the model (KOBE-658). */
  readonly placement: MemoryPlacement;
  /** `stable_plus_delta`: re-pick the held memories every this many messages (2 to 200). */
  readonly stableRepickEvery: number;
}

export type MemoryPlacement =
  "system" | "latest_user_keep" | "latest_user_strip" | "stable_plus_delta" | "tool_only";

export interface SiteMemorySettings extends MemorySwitches {
  readonly memoriesEnabled: boolean;
  readonly portableEnabled: boolean;
  readonly learnEnabled: boolean;
  readonly siteProposalsEnabled: boolean;
  /** KOBE-410: the + button's dot pulses once when Kaiju could learn from a conversation. */
  readonly learnNudgeEnabled: boolean;
  readonly settings: SiteMemorySettingsDoc;
  /**
   * Model settings whose stored model is gone (a learning alias left the catalog, an embedding
   * model's provider left the gateway). The server sends setting names (`learning_model_alias`,
   * `embedding_model`); `camelizeKeys` leaves string values alone, so they are mapped here by the
   * form. Absent from an older server.
   */
  readonly removedModels?: readonly string[];
}

export type SiteMemoryChange = Partial<Omit<SiteMemorySettings, "settings" | "removedModels">> & {
  readonly settings?: Partial<SiteMemorySettingsDoc>;
};

const nested = (o: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(snakeBody(o)).map(([k, v]) => [
      k,
      v !== null && typeof v === "object" ? snakeBody(v) : v,
    ]),
  );

export const getSiteMemory = (): Promise<ApiResult<SiteMemorySettings>> =>
  apiRequest("/v1/memory/settings?level=site");

export const putSiteMemory = (change: SiteMemoryChange): Promise<ApiResult<SiteMemorySettings>> => {
  const { settings, ...switches } = change;
  return apiRequest("/v1/memory/settings?level=site", {
    method: "PUT",
    json: { ...snakeBody(switches), ...(settings ? { settings: nested(settings) } : {}) },
  });
};

/** Vector search state on the Site memory page (`/v1/memory/vectors`, KOBE-409). */
export interface MemoryVectorJob {
  readonly state: "running" | "done" | "stopped";
  readonly model: string;
  readonly embedded: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** `budget`, `model_changed`, or the gateway's short code. */
  readonly stopReason: string | null;
}

export interface MemoryVectors {
  /** pgvector: enabled in the database, available on the server only, or missing. */
  readonly pgvector: "enabled" | "available" | "missing";
  readonly columns: boolean;
  readonly model: string | null;
  readonly modelState: "ok" | "no_model" | "provider_missing";
  readonly serverCalls: boolean;
  /** The chart's in-cluster embedding model, if it runs one. */
  readonly localModel: string | null;
  /** Gateway provider names an embedding model may use. */
  readonly providers: readonly string[];
  readonly coverage: { readonly embedded: number; readonly total: number } | null;
  readonly job: MemoryVectorJob | null;
  /** Another server replica runs the Site-wide build (KOBE-669). */
  readonly runningElsewhere?: boolean;
}

export const getMemoryVectors = (): Promise<ApiResult<MemoryVectors>> =>
  apiRequest("/v1/memory/vectors");

export const buildMemoryVectors = (): Promise<ApiResult<{ readonly job: MemoryVectorJob }>> =>
  apiRequest("/v1/memory/vectors/build", { method: "POST", json: {} });
