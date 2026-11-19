import { z } from "zod";
import {
  MEMORY_INDEX_FILE,
  semanticMemoryStatementSchema,
  type SemanticMemoryIssue,
} from "@kobe/protocol";
import { MEMORY_SUGGESTION_REASON_MAX, sql, withTeam, type KobeTx } from "@kobe/db";
import type { ApprovalKeyring } from "../../approvals/keys.js";
import { recordAudit } from "../../audit/record.js";
import { notifyMemory, settleMemoryReminders } from "../../notifications/memory.js";
import type { BlobStore } from "../../retention/blobs.js";
import { projectMemoryAccess } from "../access.js";
import { MemoryItemError, inactive, notAllowed } from "../items/errors.js";
import type { MemoryWho } from "../items/who.js";
import { MemoryStorageError, writeMemory } from "../store.js";
import { workspaceOf } from "../review/ids.js";
import {
  SUGGESTION_TOOL,
  decodeNotesApproval,
  encodeNotesApproval,
  signNotesApproval,
  verifyNotesApproval,
  type NotesChange,
} from "../review/notes-approval.js";
import {
  NO_KEY_REASON,
  STORAGE_REASON,
  planChange,
  type PlannedChange,
} from "../review/notes-target.js";
import type { NotesDeps } from "../review/project-notes.js";
import {
  lockSuggestion,
  staleMovedSuggestions,
  suggestionNotFound,
  type SuggestionRow,
} from "./rows.js";

/**
 * An editor's decision on a reader's suggestion (KOBE-652). Each step is one `withTeam()`
 * transaction with the suggestion row-locked, and re-checks at click: the suggestion is pending
 * and unexpired; its thread is still in its project (else it goes stale now, PE5, and the click is
 * refused); the caller decides the project now (owner, editor, Team admin: `edit`).
 *
 * - **Approve** runs Add to project notes' path (`notes-target.ts` `planChange`: switches, the
 *   shared-text scan, the line under `## Learned`, the index cap) with the signed approval of
 *   exactly that change (`notes-approval.ts`, tool {@link SUGGESTION_TOOL}, bound to the
 *   suggestion): preview signs it, approve verifies it against the change recomputed, writes
 *   `MEMORY.md` as the approver (Notes history and Undo there), and closes the suggestion.
 * - **Dismiss** closes it with an optional reason the suggester sees.
 *
 * Both settle the deciders' reminders and tell the suggester. Interactive only (the routes refuse
 * agent calls).
 */

export const approvePreviewSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
});
export const approveSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  base_version: z.number().int().nonnegative(),
  approval: z.string().min(1).max(4096),
});
export const dismissSchema = z.strictObject({
  reason: z.string().trim().min(1).max(MEMORY_SUGGESTION_REASON_MAX).optional(),
});

const STALE = Symbol("stale");
const STALE_MESSAGE =
  "This conversation left the project, so its suggestion no longer applies: nothing was changed.";
const EXPIRED_MESSAGE = "This suggestion expired: suggestions wait 30 days.";

/**
 * Runs `fn` on the locked, open suggestion in one transaction. A suggestion whose thread moved
 * goes stale (committed) and the click is refused afterwards.
 */
async function onOpen<T>(
  db: NotesDeps["db"],
  who: MemoryWho,
  id: string,
  fn: (tx: KobeTx, row: SuggestionRow, teamId: string) => Promise<T>,
): Promise<T> {
  const teamId = workspaceOf(who);
  const result = await withTeam(db, teamId, async (tx) => {
    const row = await lockSuggestion(tx, teamId, id);
    const access = await projectMemoryAccess(tx, teamId, who.userId, row.projectId);
    if (access === "none") throw suggestionNotFound();
    if (row.state === "stale") throw inactive(STALE_MESSAGE);
    if (row.state === "expired" || row.expired) throw inactive(EXPIRED_MESSAGE);
    if (row.state !== "pending") throw inactive("This suggestion was already decided.");
    if (row.threadProjectId !== row.projectId) {
      await staleMovedSuggestions(tx, teamId, row.threadId);
      return STALE;
    }
    if (access !== "write")
      throw notAllowed("Only the project's editors, owners and Team admins decide suggestions.");
    return fn(tx, row, teamId);
  });
  if (result === STALE) throw inactive(STALE_MESSAGE);
  return result as T;
}

function ready(deps: NotesDeps): { blobs: BlobStore; keys: ApprovalKeyring } {
  if (!deps.keys) throw notAllowed(NO_KEY_REASON);
  if (!deps.blobs) throw new MemoryStorageError(STORAGE_REASON);
  return { blobs: deps.blobs, keys: deps.keys };
}

const changeOf = (
  teamId: string,
  who: MemoryWho,
  row: SuggestionRow,
  plan: PlannedChange,
): NotesChange => ({
  teamId,
  passId: row.id,
  candidateId: row.id,
  userId: who.userId,
  projectId: plan.projectId,
  baseVersion: plan.baseVersion,
  line: plan.line,
  tool: SUGGESTION_TOOL,
});

async function plan(
  tx: KobeTx,
  blobs: BlobStore,
  teamId: string,
  who: MemoryWho,
  row: SuggestionRow,
  statement: string,
): Promise<PlannedChange> {
  const p = await planChange(
    tx,
    blobs,
    { teamId, userId: who.userId, threadId: row.threadId },
    statement,
  );
  // The thread is in the suggestion's project (checked above, row locked): the same project.
  if (p.projectId !== row.projectId) throw inactive(STALE_MESSAGE);
  return p;
}

export interface SuggestionPreview {
  readonly suggestion_id: string;
  readonly project_id: string;
  readonly path: string;
  readonly section: "Learned";
  readonly base_version: number;
  readonly line: string;
  readonly warnings: readonly SemanticMemoryIssue[];
  readonly approval: string;
}

export function previewSuggestion(
  deps: NotesDeps,
  who: MemoryWho,
  id: string,
  body: z.infer<typeof approvePreviewSchema>,
): Promise<SuggestionPreview> {
  const { blobs, keys } = ready(deps);
  return onOpen(deps.db, who, id, async (tx, row, teamId) => {
    const p = await plan(tx, blobs, teamId, who, row, body.statement ?? row.statement);
    return {
      suggestion_id: row.id,
      project_id: p.projectId,
      path: MEMORY_INDEX_FILE,
      section: "Learned",
      base_version: p.baseVersion,
      line: p.line,
      warnings: p.warnings,
      approval: encodeNotesApproval(
        signNotesApproval(keys, changeOf(teamId, who, row, p), new Date()),
      ),
    };
  });
}

export interface SuggestionApproved {
  readonly suggestion_id: string;
  readonly project_id: string;
  readonly memory_doc_id: string;
  readonly version: number;
  readonly line: string;
}

const changed = (current?: number) =>
  new MemoryItemError(
    "memory_version_conflict",
    "The project's notes changed since you looked: approve it again to see the change.",
    current && current > 0 ? { current_version: current } : {},
  );

async function close(
  tx: KobeTx,
  teamId: string,
  row: SuggestionRow,
  who: MemoryWho,
  state: "approved" | "dismissed",
  reason: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE memory_project_suggestions
       SET state = ${state}, decided_by = ${who.userId}, decided_at = now(), reason = ${reason}
     WHERE team_id = ${teamId} AND id = ${row.id} AND state = 'pending'`);
  await settleMemoryReminders(tx, teamId, row.id);
}

/** Tells the suggester (last in the transaction: the digest lock lives until commit). */
function tellSuggester(
  tx: KobeTx,
  teamId: string,
  row: SuggestionRow,
  who: MemoryWho,
  kind: "memory.suggestion.accepted" | "memory.suggestion.dismissed",
) {
  return notifyMemory(tx, teamId, [row.suggestedBy], {
    kind,
    objectId: row.id,
    projectId: row.projectId,
    actorUserId: who.userId,
  });
}

export function approveSuggestion(
  deps: NotesDeps,
  who: MemoryWho,
  id: string,
  body: z.infer<typeof approveSchema>,
): Promise<SuggestionApproved> {
  const { blobs, keys } = ready(deps);
  return onOpen(deps.db, who, id, async (tx, row, teamId) => {
    const statement = body.statement ?? row.statement;
    const p = await plan(tx, blobs, teamId, who, row, statement);
    if (p.baseVersion !== body.base_version) throw changed(p.baseVersion);
    const verdict = verifyNotesApproval(
      keys,
      decodeNotesApproval(body.approval),
      changeOf(teamId, who, row, p),
      new Date(),
    );
    if (verdict === "expired") throw inactive("The approval expired: approve it again.");
    if (verdict !== "ok")
      throw notAllowed("This approval doesn't cover this change: approve it again.");
    const written = await writeMemory(
      tx,
      blobs,
      teamId,
      { scope: "project", projectId: p.projectId },
      { path: MEMORY_INDEX_FILE, content: p.content, expectedVersion: p.baseVersion },
      { kind: "user", userId: who.userId },
    );
    if (!written.ok) {
      if (written.code === "version_conflict") throw changed(written.currentVersion);
      throw new MemoryItemError("memory_scope_full", written.message);
    }
    await recordAudit(tx, {
      action: "memory.written",
      teamId,
      target: {
        scope: "project",
        memoryDocId: written.docId,
        version: written.version,
        ...(written.previousVersion === undefined
          ? {}
          : { previousVersion: written.previousVersion }),
        actorKind: "user",
        sizeBytes: written.sizeBytes,
      },
    });
    await close(tx, teamId, row, who, "approved", null);
    await recordAudit(tx, {
      action: "memory.suggestion.accepted",
      teamId,
      target: {
        suggestionId: row.id,
        threadId: row.threadId,
        projectId: row.projectId,
        memoryDocId: written.docId,
        version: written.version,
        edited: statement !== row.statement,
      },
    });
    await tellSuggester(tx, teamId, row, who, "memory.suggestion.accepted");
    return {
      suggestion_id: row.id,
      project_id: row.projectId,
      memory_doc_id: written.docId,
      version: written.version,
      line: p.line,
    };
  });
}

export function dismissSuggestion(
  deps: NotesDeps,
  who: MemoryWho,
  id: string,
  body: z.infer<typeof dismissSchema>,
): Promise<{ readonly suggestion_id: string; readonly state: "dismissed" }> {
  return onOpen(deps.db, who, id, async (tx, row, teamId) => {
    const reason = body.reason ?? null;
    await close(tx, teamId, row, who, "dismissed", reason);
    await recordAudit(tx, {
      action: "memory.suggestion.dismissed",
      teamId,
      target: {
        suggestionId: row.id,
        threadId: row.threadId,
        projectId: row.projectId,
        reasonGiven: reason !== null,
      },
    });
    await tellSuggester(tx, teamId, row, who, "memory.suggestion.dismissed");
    return { suggestion_id: row.id, state: "dismissed" };
  });
}
