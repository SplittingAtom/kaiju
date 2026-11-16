/**
 * Workspace proposals over the shared API client (KOBE-397, SM22): a member proposes a To review
 * candidate (`/v1/memory/review/candidates/:id/propose`); curators decide at
 * `/v1/memory/proposals`. Responses arrive camelized; bodies use the routes' snake_case. The
 * server checks every call again (curator rights, never one's own, pending and unexpired).
 */
import type { ItemKind, MemoryItem, Overrides } from "./items-api";
import type { RelatedItem } from "./review-api";
import { apiRequest, type ApiResult } from "../api/client";

export type ProposalState = "pending" | "approved" | "rejected" | "expired";

export interface Proposal {
  readonly id: string;
  readonly statement: string;
  readonly kind: ItemKind;
  readonly rationale: string | null;
  readonly state: ProposalState;
  readonly proposer: { readonly id: string; readonly name: string };
  /** The conversation the person said it in (null once it is gone). */
  readonly threadId: string | null;
  readonly evidence: readonly { readonly entryId: string; readonly quote: string }[];
  readonly reason: string | null;
  readonly decidedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** A pending proposal in the curators' queue, with what the memory checks find now. */
export interface QueuedProposal extends Proposal {
  readonly warnings: readonly string[];
  readonly nearDuplicates: readonly RelatedItem[];
  readonly policyConflicts: readonly RelatedItem[];
}

/** One of the caller's own proposals. */
export interface MyProposal extends Proposal {
  /** Sent back for changes and open again in To review. */
  readonly backInReview: boolean;
  readonly mayRepropose: boolean;
}

export interface ProposeEdit {
  readonly statement?: string;
  readonly kind?: ItemKind;
  readonly rationale?: string;
}

export interface Proposed {
  readonly proposalId: string;
  readonly candidateId: string;
  readonly expiresAt: string;
}

export interface ProposalsApi {
  propose(candidateId: string, edit: ProposeEdit): Promise<ApiResult<Proposed>>;
  queue(): Promise<ApiResult<{ readonly proposals: readonly QueuedProposal[] }>>;
  mine(): Promise<ApiResult<{ readonly proposals: readonly MyProposal[] }>>;
  approve(
    id: string,
    edit: { readonly statement?: string; readonly kind?: ItemKind },
    overrides?: Overrides,
  ): Promise<ApiResult<{ readonly proposalId: string; readonly item: MemoryItem }>>;
  turnDown(
    id: string,
    outcome: "dismiss" | "request-changes",
    reason: string,
  ): Promise<ApiResult<{ readonly proposalId: string; readonly backInReview: boolean }>>;
  repropose(id: string): Promise<ApiResult<Proposed>>;
}

const enc = encodeURIComponent;
const BASE = "/v1/memory/proposals";

/** The overrides a curator saves over (lint warnings, a Policy conflict) in the wire's names. */
export function overridesBody(overrides?: Overrides): Record<string, unknown> {
  if (!overrides?.lint && !overrides?.policyConflict) return {};
  return {
    overrides: {
      ...(overrides.lint ? { lint: true } : {}),
      ...(overrides.policyConflict ? { policy_conflict: true } : {}),
    },
  };
}

export function createProposalsApi(teamId: string, fetchFn?: typeof fetch): ProposalsApi {
  const send = <T>(path: string, method: "GET" | "POST", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn, errorDetails: true });
  return {
    propose: (candidateId, edit) =>
      send(`/v1/memory/review/candidates/${enc(candidateId)}/propose`, "POST", edit),
    queue: () => send(BASE, "GET"),
    mine: () => send(`${BASE}/mine`, "GET"),
    approve: (id, edit, overrides) =>
      send(`${BASE}/${enc(id)}/approve`, "POST", { ...edit, ...overridesBody(overrides) }),
    turnDown: (id, outcome, reason) => send(`${BASE}/${enc(id)}/${outcome}`, "POST", { reason }),
    repropose: (id) => send(`${BASE}/${enc(id)}/repropose`, "POST", {}),
  };
}
