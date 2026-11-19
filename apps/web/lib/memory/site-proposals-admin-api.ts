/**
 * Site proposals, Site side, over the shared API client (`/v1/site/memory/proposals`, KOBE-403
 * for KOBE-405): what Team admins confirmed for the Site, for Site admins and Site memory
 * stewards. Responses arrive camelized (also the `counts` keys); bodies use the routes'
 * snake_case. The server checks every call again (Site curator, never one's own, awaiting the
 * Site and unexpired, the Workspace's switch on approve and merge, never one they confirmed
 * for their workspace: KOBE-666).
 */
import type { ApiError, ApiResult } from "../api/client";
import { apiRequest } from "../api/client";
import type { ItemKind, MemoryItem, Overrides } from "./items-api";
import { overridesBody } from "./proposals-api";

export const SITE_PROPOSAL_STATES = [
  "awaiting_site",
  "awaiting_team",
  "approved",
  "merged",
  "rejected",
  "expired",
  "withdrawn",
] as const;
export type SiteProposalState = (typeof SITE_PROPOSAL_STATES)[number] | "changes_requested";

/** Most request-changes rounds (mirrors `SITE_MEMORY_PROPOSAL_ROUNDS_MAX`, KOBE-402). */
export const SITE_PROPOSAL_ROUNDS_MAX = 3;
/** Longest request-changes note (`SITE_PROPOSAL_NOTE_MAX`, KOBE-403). */
export const SITE_PROPOSAL_NOTE_MAX = 500;
/** Longest rejection reason (`SITE_MEMORY_PROPOSAL_TEXT_MAX`). */
export const SITE_PROPOSAL_REASON_MAX = 1000;

export interface Person {
  readonly id: string;
  readonly name: string;
}

export interface SiteProposal {
  readonly id: string;
  readonly statement: string;
  readonly kind: ItemKind;
  readonly justification: string;
  /** A Workspace curator other than the proposer endorsed it. */
  readonly endorsed: boolean;
  readonly state: SiteProposalState;
  /** Request-changes rounds so far (at most {@link SITE_PROPOSAL_ROUNDS_MAX}). */
  readonly rounds: number;
  readonly proposer: Person;
  readonly confirmedBy: Person | null;
  readonly confirmedAt: string | null;
  readonly reason: string | null;
  readonly changesNote: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: Person | null;
  readonly mergedInto: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fromWorkspace: { readonly id: string; readonly name: string | null };
  /**
   * What the viewer may do (KOBE-666): decide it at step 2, or why not: they proposed it, or they
   * confirmed it for their workspace as a Team admin (in any round).
   */
  readonly may?: {
    readonly decide: boolean;
    readonly decideBlocked: SiteDecideBlocked | null;
  };
}

/** Why a Site curator may not decide a proposal (the server checks again on every action). */
export type SiteDecideBlocked = "own_proposal" | "confirmed";

export interface RelatedSiteItem {
  readonly id: string;
  readonly version: number;
  readonly statement: string;
  readonly policy?: boolean;
}

/** What the shared checks find for the proposal against Site memory and Policy now. */
export interface SiteProposalChecks {
  readonly secret: boolean;
  readonly warnings: readonly string[];
  readonly nearDuplicates: readonly RelatedSiteItem[];
  readonly policyConflicts: readonly RelatedSiteItem[];
}

export interface SiteProposalDetail {
  readonly proposal: SiteProposal;
  readonly checks: SiteProposalChecks;
}

export type SiteProposalCounts = Readonly<Partial<Record<SiteProposalState, number>>>;

export interface SiteQueue {
  readonly proposals: readonly SiteProposal[];
  readonly counts: SiteProposalCounts;
}

export interface SiteQueueQuery {
  readonly state: SiteProposalState;
  readonly fromTeamId?: string | undefined;
}

export interface ApproveEdit {
  readonly statement?: string;
  readonly kind?: ItemKind;
  /** Site admins only. */
  readonly policy?: boolean;
}

export interface MergeInto {
  readonly itemId: string;
  readonly statement?: string;
  readonly expectedVersion?: number;
}

export interface SiteDecision {
  readonly proposal: SiteProposal;
  readonly item: MemoryItem;
}

export interface SiteProposalsApi {
  list(q: SiteQueueQuery): Promise<ApiResult<SiteQueue>>;
  get(id: string): Promise<ApiResult<SiteProposalDetail>>;
  approve(id: string, edit: ApproveEdit, overrides?: Overrides): Promise<ApiResult<SiteDecision>>;
  merge(id: string, into: MergeInto, overrides?: Overrides): Promise<ApiResult<SiteDecision>>;
  reject(id: string, reason: string): Promise<ApiResult<{ readonly proposal: SiteProposal }>>;
  requestChanges(id: string, note: string): Promise<ApiResult<{ readonly proposal: SiteProposal }>>;
}

const enc = encodeURIComponent;
const BASE = "/v1/site/memory/proposals";

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The camelized `counts` answer back in the wire's state names. */
export function countsFromWire(raw: Readonly<Record<string, number>>): SiteProposalCounts {
  const out: Partial<Record<SiteProposalState, number>> = {};
  for (const state of [...SITE_PROPOSAL_STATES, "changes_requested"] as const) {
    const n = raw[camel(state)] ?? raw[state];
    if (typeof n === "number") out[state] = n;
  }
  return out;
}

export function listQuery(q: SiteQueueQuery): string {
  const params = new URLSearchParams({ state: q.state });
  if (q.fromTeamId) params.set("from_team_id", q.fromTeamId);
  return `${BASE}?${params.toString()}`;
}

/** `teamId`: the session's active Workspace when there is one (writes then need it). */
export function createSiteProposalsApi(
  teamId: string | undefined,
  fetchFn?: typeof fetch,
): SiteProposalsApi {
  const send = <T>(path: string, method: "GET" | "POST", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn, errorDetails: true });
  return {
    list: async (q) => {
      const res = await send<{ proposals: SiteProposal[]; counts: Record<string, number> }>(
        listQuery(q),
        "GET",
      );
      return res.ok
        ? { ...res, data: { ...res.data, counts: countsFromWire(res.data.counts) } }
        : res;
    },
    get: (id) => send(`${BASE}/${enc(id)}`, "GET"),
    approve: (id, edit, overrides) =>
      send(`${BASE}/${enc(id)}/approve`, "POST", { ...edit, ...overridesBody(overrides) }),
    merge: (id, into, overrides) =>
      send(`${BASE}/${enc(id)}/merge`, "POST", {
        item_id: into.itemId,
        ...(into.statement === undefined ? {} : { statement: into.statement }),
        ...(into.expectedVersion === undefined ? {} : { expected_version: into.expectedVersion }),
        ...overridesBody(overrides),
      }),
    reject: (id, reason) => send(`${BASE}/${enc(id)}/reject`, "POST", { reason }),
    requestChanges: (id, note) => send(`${BASE}/${enc(id)}/request-changes`, "POST", { note }),
  };
}

/** A refused Site decision in words: the switch, a changed state, a version conflict. */
export function describeSiteProposalError(error: ApiError): string {
  switch (error.code) {
    case "memory_disabled":
      return "The proposing workspace has turned off Members may propose to the Site (or memory), so nothing from it enters Site memory. You can still reject it or request changes.";
    case "memory_item_inactive":
      // The server says which: already decided, expired, back with the Team admins, rounds used.
      return `${error.message} Reload the queue to see where it is now.`;
    case "memory_item_not_found":
      return "This proposal or Site memory no longer exists, or you can't review it.";
    case "memory_version_conflict":
      return "That Site memory changed since you opened it. Choose it again to merge into its latest version.";
    case "memory_not_allowed":
      return error.message;
    case "memory_secret":
      return "This looks like a password, key or token. Memories never hold secrets: reject it.";
    default:
      return error.message;
  }
}
