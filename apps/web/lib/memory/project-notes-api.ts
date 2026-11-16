/**
 * Add to project notes from To review (`/v1/memory/review/candidates/:id/project-notes`,
 * KOBE-398). Two calls: `preview` returns the exact Notes change (the line under `## Learned` in
 * the project's `MEMORY.md` and the file version it applies to) with its signed approval, an
 * opaque string; `add` sends that approval back unchanged. The server re-checks everything at
 * each call (role, switches, the line cap, the thread still in the project, the file unchanged).
 */
import { apiRequest, type ApiResult } from "../api/client";

/** The list's `project_notes`: null when the thread is in no project the caller can see. */
export interface ProjectNotesStatus {
  readonly projectId: string;
  /** `read`: a reader (Suggest to editors, KOBE-652); `write`: editor, owner or Team admin. */
  readonly access: "read" | "write";
  readonly available: boolean;
  /** Why it can't be used now (off, full, a reader), or null. */
  readonly reason: string | null;
}

export interface NotesPreview {
  readonly candidateId: string;
  readonly projectId: string;
  readonly path: string;
  readonly section: string;
  readonly baseVersion: number;
  readonly line: string;
  readonly approval: string;
}

export interface NotesAdded {
  readonly candidateId: string;
  readonly projectId: string;
  readonly memoryDocId: string;
  readonly version: number;
  readonly line: string;
}

export interface ProjectNotesApi {
  preview(id: string, statement?: string): Promise<ApiResult<NotesPreview>>;
  add(id: string, preview: NotesPreview, statement?: string): Promise<ApiResult<NotesAdded>>;
}

const BASE = "/v1/memory/review/candidates";

export function createProjectNotesApi(teamId: string, fetchFn?: typeof fetch): ProjectNotesApi {
  const post = <T>(path: string, json: unknown) =>
    apiRequest<T>(path, { method: "POST", json, teamId, fetchFn, errorDetails: true });
  const withStatement = (statement?: string) => (statement === undefined ? {} : { statement });
  return {
    preview: (id, statement) =>
      post(`${BASE}/${encodeURIComponent(id)}/project-notes/preview`, withStatement(statement)),
    add: (id, preview, statement) =>
      post(`${BASE}/${encodeURIComponent(id)}/project-notes`, {
        ...withStatement(statement),
        base_version: preview.baseVersion,
        approval: preview.approval,
      }),
  };
}
