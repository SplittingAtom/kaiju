import { withTeam, type KaijuDb } from "@kaiju/db";
import { projectMemoryAccess } from "../access.js";
import type { MemoryWho } from "../items/who.js";
import { workspaceOf } from "../review/ids.js";
import {
  decidableSuggestions,
  ownSuggestions,
  suggestionNotFound,
  type SuggestionRow,
} from "./rows.js";

/**
 * `GET /v1/memory/suggestions` (KOBE-652): readers' suggestions to project Notes.
 *
 * - With `project_id` (project Memory → Suggestions): the open suggestions when the caller decides
 *   the project (owner, editor, Team admin; `can_decide`), and the caller's own suggestions there
 *   in every state (a dismissal's reason included). 404 for a project the caller can't see.
 * - Without (To review): the open suggestions of every project the caller decides.
 *
 * Open = pending, unexpired, and its thread still in its project (a moved one never shows; the
 * move or the next click expires it).
 */

export function suggestionCard(r: SuggestionRow) {
  return {
    id: r.id,
    project_id: r.projectId,
    project_name: r.projectName,
    thread_id: r.threadId,
    statement: r.statement,
    kind: r.kind,
    evidence: r.evidence,
    suggested_by: { id: r.suggestedBy, name: r.suggesterName },
    state: r.state,
    reason: r.reason,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    decided_at: r.decidedAt,
  };
}

export type SuggestionCard = ReturnType<typeof suggestionCard>;

export interface SuggestionList {
  readonly project_id: string | null;
  readonly can_decide: boolean;
  readonly suggestions: readonly SuggestionCard[];
  readonly mine: readonly SuggestionCard[];
}

export function listSuggestions(
  db: KaijuDb,
  who: MemoryWho,
  projectId?: string,
): Promise<SuggestionList> {
  const teamId = workspaceOf(who);
  const ids = { teamId, userId: who.userId };
  return withTeam(db, teamId, async (tx) => {
    if (projectId === undefined) {
      const open = await decidableSuggestions(tx, ids);
      return {
        project_id: null,
        can_decide: open.length > 0,
        suggestions: open.map(suggestionCard),
        mine: [],
      };
    }
    const access = await projectMemoryAccess(tx, teamId, who.userId, projectId);
    if (access === "none") throw suggestionNotFound();
    const canDecide = access === "write";
    return {
      project_id: projectId,
      can_decide: canDecide,
      suggestions: canDecide
        ? (await decidableSuggestions(tx, ids, projectId)).map(suggestionCard)
        : [],
      mine: (await ownSuggestions(tx, ids, projectId)).map(suggestionCard),
    };
  });
}
