/**
 * Readers' suggestions to a project's Notes (KOBE-652) over the shared API client. A project
 * reader suggests a To review candidate (`/v1/memory/review/candidates/:id/suggest`); the
 * project's editors, owners and Team admins list them (`/v1/memory/suggestions`, per project or
 * across their projects for To review), approve one (preview → the signed change → approve, as
 * Add to project notes) or dismiss it with an optional reason. Responses arrive camelized; the
 * server re-checks everything at each call.
 */
import { apiRequest, type ApiResult } from "../api/client";
import type { ItemKind } from "./items-api";
import type { NotesPreview } from "./project-notes-api";

/**
 * `expired`: no decision within 30 days; `stale`: its conversation left the project first, so it
 * no longer applies (KOBE-668).
 */
export type SuggestionState = "pending" | "approved" | "dismissed" | "expired" | "stale";

export interface Suggestion {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly threadId: string;
  readonly statement: string;
  readonly kind: ItemKind;
  /** Quotes of the suggester's own messages in the thread. */
  readonly evidence: readonly { readonly entryId: string; readonly quote: string }[];
  readonly suggestedBy: { readonly id: string; readonly name: string };
  readonly state: SuggestionState;
  /** A dismissal's reason, when the decider gave one. */
  readonly reason: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

export interface SuggestionList {
  readonly projectId: string | null;
  /** The caller decides this project's suggestions (owner, editor, Team admin). */
  readonly canDecide: boolean;
  /** Waiting for a decision (only for those who decide). */
  readonly suggestions: readonly Suggestion[];
  /** The caller's own suggestions in the project, every state. */
  readonly mine: readonly Suggestion[];
}

export interface Suggested {
  readonly suggestionId: string;
  readonly candidateId: string;
  readonly projectId: string;
  readonly expiresAt: string;
}

/** The exact Notes change to approve: as Add to project notes' preview, for a suggestion. */
export type SuggestionPreview = Omit<NotesPreview, "candidateId"> & {
  readonly suggestionId: string;
};

export interface SuggestionApproved {
  readonly suggestionId: string;
  readonly projectId: string;
  readonly version: number;
  readonly line: string;
}

export interface SuggestionsApi {
  suggest(
    candidateId: string,
    edit: { readonly statement?: string; readonly kind?: ItemKind },
  ): Promise<ApiResult<Suggested>>;
  list(projectId?: string): Promise<ApiResult<SuggestionList>>;
  preview(id: string): Promise<ApiResult<SuggestionPreview>>;
  approve(id: string, preview: SuggestionPreview): Promise<ApiResult<SuggestionApproved>>;
  dismiss(
    id: string,
    reason?: string,
  ): Promise<ApiResult<{ readonly suggestionId: string; readonly state: "dismissed" }>>;
}

const BASE = "/v1/memory/suggestions";
const enc = encodeURIComponent;

export function createSuggestionsApi(teamId: string, fetchFn?: typeof fetch): SuggestionsApi {
  const send = <T>(path: string, method: "GET" | "POST", json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn, errorDetails: true });
  return {
    suggest: (candidateId, edit) =>
      send(`/v1/memory/review/candidates/${enc(candidateId)}/suggest`, "POST", {
        ...(edit.statement === undefined ? {} : { statement: edit.statement }),
        ...(edit.kind === undefined ? {} : { kind: edit.kind }),
      }),
    list: (projectId) =>
      send(projectId === undefined ? BASE : `${BASE}?project_id=${enc(projectId)}`, "GET"),
    preview: (id) => send(`${BASE}/${enc(id)}/preview`, "POST", {}),
    approve: (id, preview) =>
      send(`${BASE}/${enc(id)}/approve`, "POST", {
        base_version: preview.baseVersion,
        approval: preview.approval,
      }),
    dismiss: (id, reason) =>
      send(`${BASE}/${enc(id)}/dismiss`, "POST", reason === undefined ? {} : { reason }),
  };
}
