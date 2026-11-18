/**
 * Site proposals, Workspace side, over the shared API client (KOBE-404 on KOBE-403's
 * `/v1/memory/site-proposals`): Propose → Site on a To review candidate, Propose to Site on a
 * Workspace memory (curators), and the Team admins' confirmation queue (confirm, endorse,
 * withdraw). Only the statement, kind and justification ever cross (the wall, SM20). Responses
 * arrive camelized; bodies use the routes' snake_case. The server checks every call again.
 */
import type { ItemKind } from "./items-api";
import { apiRequest, type ApiResult } from "../api/client";

/** Longest justification (`SITE_MEMORY_PROPOSAL_TEXT_MAX`). */
export const SITE_JUSTIFICATION_MAX = 1000;
/** Most request-changes rounds before the Site must decide (`SITE_MEMORY_PROPOSAL_ROUNDS_MAX`). */
export const SITE_ROUNDS_MAX = 3;

export type SiteProposalState =
  | "awaiting_team"
  | "awaiting_site"
  | "changes_requested"
  | "approved"
  | "merged"
  | "rejected"
  | "expired"
  | "withdrawn";

export interface Person {
  readonly id: string;
  readonly name: string;
}

/** A proposal as the proposing Workspace sees it (no Site curator names). */
export interface SiteProposal {
  readonly id: string;
  readonly statement: string;
  readonly kind: ItemKind;
  readonly justification: string;
  readonly endorsed: boolean;
  readonly state: SiteProposalState;
  /** Request-changes rounds so far (at most {@link SITE_ROUNDS_MAX}). */
  readonly rounds: number;
  readonly proposer: Person;
  readonly confirmedBy: Person | null;
  readonly confirmedAt: string | null;
  /** The Site's reason for a rejection. */
  readonly reason: string | null;
  /** The Site's latest request-changes note while the proposal is open. */
  readonly changesNote: string | null;
  readonly decidedAt: string | null;
  readonly mergedInto: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** What the caller may do now (the server checks again). */
  readonly may: {
    readonly confirm: boolean;
    readonly endorse: boolean;
    readonly withdraw: boolean;
  };
}

/** What the shared memory checks find against Site memory (codes and ids; they don't block). */
export interface SiteChecks {
  readonly warnings: readonly string[];
  readonly policyConflicts: readonly { readonly id: string; readonly version: number }[];
}

export interface SiteProposed {
  readonly proposal: SiteProposal;
  readonly checks: SiteChecks;
}

export interface SiteProposalList {
  readonly proposals: readonly SiteProposal[];
  readonly counts: Readonly<Partial<Record<SiteProposalState, number>>>;
}

export interface SiteProposalEdit {
  readonly statement?: string;
  readonly kind?: ItemKind;
  readonly justification?: string;
}

export interface SiteProposalsApi {
  proposeCandidate(
    candidateId: string,
    body: { readonly justification: string; readonly statement?: string; readonly kind?: ItemKind },
  ): Promise<ApiResult<SiteProposed>>;
  proposeItem(
    itemId: string,
    body: { readonly justification: string; readonly statement?: string; readonly kind?: ItemKind },
  ): Promise<ApiResult<SiteProposed>>;
  list(state?: SiteProposalState): Promise<ApiResult<SiteProposalList>>;
  confirm(id: string, edit: SiteProposalEdit): Promise<ApiResult<SiteProposed>>;
  endorse(id: string): Promise<ApiResult<{ readonly proposal: SiteProposal }>>;
  withdraw(id: string): Promise<ApiResult<{ readonly proposal: SiteProposal }>>;
}

const enc = encodeURIComponent;
const BASE = "/v1/memory/site-proposals";
/** The most one list returns (`SITE_PROPOSALS_LIST_MAX`). */
const LIST_LIMIT = 100;

export function createSiteProposalsApi(teamId: string, fetchFn?: typeof fetch): SiteProposalsApi {
  const send = <T>(path: string, method: "GET" | "POST", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn, errorDetails: true });
  return {
    proposeCandidate: (candidateId, body) =>
      send(`${BASE}/candidates/${enc(candidateId)}`, "POST", body),
    proposeItem: (itemId, body) => send(BASE, "POST", { item_id: itemId, ...body }),
    list: (state) =>
      send(`${BASE}?${state ? `state=${enc(state)}&` : ""}limit=${LIST_LIMIT}`, "GET"),
    confirm: (id, edit) => send(`${BASE}/${enc(id)}/confirm`, "POST", edit),
    endorse: (id) => send(`${BASE}/${enc(id)}/endorse`, "POST", {}),
    withdraw: (id) => send(`${BASE}/${enc(id)}/withdraw`, "POST", {}),
  };
}

/** A proposal's state in words. */
export const SITE_STATE_LABELS: Readonly<Record<SiteProposalState, string>> = {
  awaiting_team: "Waiting for a Team admin",
  awaiting_site: "Waiting for the Site",
  changes_requested: "Changes requested",
  approved: "Approved: a Site memory",
  merged: "Merged into a Site memory",
  rejected: "Not accepted",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

/**
 * One line about what the checks found, for the person who just proposed or confirmed (null:
 * nothing). Policy conflicts and warnings never block; the Site's curators see them too.
 */
export function describeSiteChecks(checks: SiteChecks): string | null {
  const parts: string[] = [];
  if (checks.policyConflicts.length > 0)
    parts.push(
      checks.policyConflicts.length === 1
        ? "it may contradict a Site Policy item"
        : `it may contradict ${checks.policyConflicts.length} Site Policy items`,
    );
  if (checks.warnings.length > 0)
    parts.push(
      checks.warnings.length === 1
        ? "the memory checks have a warning"
        : `the memory checks have ${checks.warnings.length} warnings`,
    );
  if (parts.length === 0) return null;
  return `Note: ${parts.join(", and ")}. The Site's curators see this when they decide.`;
}

/** Proposals loaded for a page: every open one (up to the list limit per step) and the newest closed. */
export interface LoadedSiteProposals {
  readonly proposals: readonly SiteProposal[];
  readonly counts: SiteProposalList["counts"];
}

/**
 * Reads what a page shows in three lists (each at most 100, the API has no cursor): waiting for
 * a Team admin and waiting for the Site, oldest first, and all states, newest first, for the
 * closed ones. Merged by id; the counts say how many there are in all.
 */
export async function loadSiteProposals(
  api: Pick<SiteProposalsApi, "list">,
): Promise<ApiResult<LoadedSiteProposals>> {
  const answers = await Promise.all([
    api.list("awaiting_team"),
    api.list("awaiting_site"),
    api.list(),
  ]);
  const failed = answers.find((a) => !a.ok);
  if (failed && !failed.ok) return failed;
  const byId = new Map<string, SiteProposal>();
  let counts: SiteProposalList["counts"] = {};
  for (const a of answers)
    if (a.ok) {
      for (const p of a.data.proposals) if (!byId.has(p.id)) byId.set(p.id, p);
      counts = a.data.counts;
    }
  return { ok: true, status: 200, data: { proposals: [...byId.values()], counts } };
}

/** "Showing 100 of 140 closed proposals (at most 100 per list)." when a group holds more. */
export function moreThanShown(shown: number, total: number, what: string): string | null {
  return total > shown
    ? `Showing ${shown} of ${total} ${what} (at most ${LIST_LIMIT} per list).`
    : null;
}
