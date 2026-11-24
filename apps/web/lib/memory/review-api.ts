/**
 * To review over the shared API client (`/v1/memory/review`, KOBE-396): a thread author's learning
 * candidates and their decisions. Responses arrive camelized; bodies use the route's snake_case.
 * Every decision is checked again by the server (author, scope rules, switches, limits, the
 * memory checks), so a refusal comes back with the item store's codes and check details.
 */
import type { ItemKind, MemoryItem, Overrides } from "./items-api";
import { apiRequest, type ApiResult } from "../api/client";
import type { ProjectNotesStatus } from "./project-notes-api";

export type ReviewScope = "user" | "portable" | "team";

export interface RelatedItem {
  readonly id: string;
  readonly version: number;
  readonly statement: string;
}

export interface Candidate {
  readonly id: string;
  readonly passId: string;
  readonly statement: string;
  readonly kind: ItemKind;
  readonly destination: ReviewScope | "project_notes";
  /** The scope it saves to as suggested. */
  readonly scope: ReviewScope;
  readonly allowedScopes: readonly ReviewScope[];
  readonly scopeLocked: boolean;
  /** A new personal memory: part of Save all mine. */
  readonly saveAllMine: boolean;
  readonly projectSpecific: boolean;
  readonly source: "stated" | "confirmed" | "inferred";
  readonly operation: "add" | "update" | "supersede" | "conflict";
  /** The memory an update, supersede or conflict acts on (null when gone or for add). */
  readonly target: RelatedItem | null;
  /**
   * The memory was changed since Kaiju suggested this (KOBE-779): the comparison shows it as it is
   * now, and Save sends the version shown (`targetVersion`).
   */
  readonly targetChanged?: boolean;
  readonly confidence: number;
  readonly rationale: string;
  readonly evidence: readonly { readonly entryId: string; readonly quote: string }[];
  readonly warnings: readonly string[];
  readonly policyConflicts: readonly RelatedItem[];
  readonly nearDuplicates: readonly RelatedItem[];
  readonly expiresAt: string;
}

export interface ReviewList {
  readonly threadId: string;
  readonly canCurateWorkspace: boolean;
  readonly candidates: readonly Candidate[];
  readonly skillHints: readonly { readonly title: string; readonly summary: string }[];
  /** Add to project notes in this thread (KOBE-398); null or absent: not a project thread. */
  readonly projectNotes?: ProjectNotesStatus | null;
}

export interface CandidateEdit {
  readonly statement?: string;
  readonly kind?: ItemKind;
  readonly scope?: ReviewScope;
  /** The changed memory's version the person reviewed on the card (KOBE-779). */
  readonly targetVersion?: number;
}

export interface SavedCandidate {
  readonly candidateId: string;
  readonly item: MemoryItem;
}

export interface ReviewApi {
  list(threadId: string): Promise<ApiResult<ReviewList>>;
  save(id: string, edit: CandidateEdit, overrides?: Overrides): Promise<ApiResult<SavedCandidate>>;
  dismiss(id: string): Promise<ApiResult<{ readonly candidateId: string }>>;
  saveAll(
    ids: readonly string[],
  ): Promise<ApiResult<{ readonly saved: readonly SavedCandidate[] }>>;
  undo(ids: readonly string[]): Promise<ApiResult<{ readonly reopened: readonly string[] }>>;
  seen(threadId: string): Promise<ApiResult<{ readonly read: number }>>;
}

const BASE = "/v1/memory/review";
const enc = encodeURIComponent;

export function saveBody(edit: CandidateEdit, overrides?: Overrides): Record<string, unknown> {
  return {
    ...(edit.statement === undefined ? {} : { statement: edit.statement }),
    ...(edit.kind === undefined ? {} : { kind: edit.kind }),
    ...(edit.scope === undefined ? {} : { scope: edit.scope }),
    ...(edit.scope === "portable" ? { confirm_portable: true } : {}),
    ...(edit.targetVersion === undefined ? {} : { target_version: edit.targetVersion }),
    ...(overrides?.lint || overrides?.policyConflict
      ? {
          overrides: {
            ...(overrides.lint ? { lint: true } : {}),
            ...(overrides.policyConflict ? { policy_conflict: true } : {}),
          },
        }
      : {}),
  };
}

export function createReviewApi(teamId: string, fetchFn?: typeof fetch): ReviewApi {
  const send = <T>(path: string, method: "GET" | "POST", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn, errorDetails: true });
  return {
    list: (threadId) => send(`${BASE}?thread_id=${enc(threadId)}`, "GET"),
    save: (id, edit, overrides) =>
      send(`${BASE}/candidates/${enc(id)}/save`, "POST", saveBody(edit, overrides)),
    dismiss: (id) => send(`${BASE}/candidates/${enc(id)}/dismiss`, "POST", {}),
    saveAll: (ids) => send(`${BASE}/save-all`, "POST", { candidate_ids: ids }),
    undo: (ids) => send(`${BASE}/undo`, "POST", { candidate_ids: ids }),
    seen: (threadId) => send(`${BASE}/seen`, "POST", { thread_id: threadId }),
  };
}
