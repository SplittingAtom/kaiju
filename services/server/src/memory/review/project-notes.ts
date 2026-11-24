import { z } from "zod";
import {
  MEMORY_INDEX_FILE,
  semanticMemoryStatementSchema,
  type SemanticMemoryIssue,
} from "@kaiju/protocol";
import { withTeam, type KaijuDb } from "@kaiju/db";
import type { ApprovalKeyring } from "../../approvals/keys.js";
import { recordAudit } from "../../audit/record.js";
import type { BlobStore } from "../../retention/blobs.js";
import { MemoryItemError, inactive, notAllowed } from "../items/errors.js";
import type { MemoryWho } from "../items/who.js";
import { MemoryStorageError, writeMemory } from "../store.js";
import { workspaceOf } from "./ids.js";
import {
  decodeNotesApproval,
  encodeNotesApproval,
  signNotesApproval,
  verifyNotesApproval,
  type NotesChange,
} from "./notes-approval.js";
import {
  NO_KEY_REASON,
  STORAGE_REASON,
  planChange,
  threadProject,
  unavailableReason,
  type PlannedChange,
} from "./notes-target.js";
import { settleWhenDecided } from "./notify.js";
import { decideCandidate, lockCandidate, type CandidateRow } from "./stored.js";

/**
 * Add to project notes (KOBE-398, SM7): from To review in a project thread, a candidate's
 * statement goes under `## Learned` in the project's `MEMORY.md` (D24 Notes; never a Workspace
 * memory item). Two steps, each re-checked in one `withTeam()` transaction with the candidate
 * row-locked (the caller's own, open, unexpired: `lockCandidate`) and the project read now
 * (`notes-target.ts`: role `edit`, switches, the index line cap):
 *
 * 1. **Preview** computes the exact change and signs it (`notes-approval.ts`); the person sees
 *    the line and the file it goes into and approves.
 * 2. **Add** recomputes the change, refuses unless the signed approval covers exactly it (same
 *    line, same `MEMORY.md` version, same project and person), writes it as the person (Notes
 *    history shows it), and marks the candidate saved with audit.
 *
 * Interactive only: the routes refuse agent (Kaiju admin tool) calls, and runs (auto, scheduled)
 * have no path here; a run's own project writes stay `remember` with its approval (agent.ts).
 */

export interface NotesDeps {
  readonly db: KaijuDb;
  readonly blobs: BlobStore | undefined;
  readonly keys: ApprovalKeyring | undefined;
}

export const notesPreviewSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
});
export const notesAddSchema = z.strictObject({
  statement: semanticMemoryStatementSchema.optional(),
  base_version: z.number().int().nonnegative(),
  /** The preview's `approval`, unchanged. */
  approval: z.string().min(1).max(4096),
});
export type NotesAdd = z.infer<typeof notesAddSchema>;

/** The card's view: null when the thread is in no project the caller can see. */
export interface ProjectNotesStatus {
  readonly project_id: string;
  readonly access: "read" | "write";
  readonly available: boolean;
  readonly reason: string | null;
}

export function projectNotesStatus(
  deps: NotesDeps,
  who: MemoryWho,
  threadId: string,
): Promise<ProjectNotesStatus | null> {
  const teamId = workspaceOf(who);
  return withTeam(deps.db, teamId, async (tx) => {
    const project = await threadProject(tx, { teamId, userId: who.userId, threadId });
    if (!project) return null;
    const reason =
      project.access === "write" && !deps.keys
        ? NO_KEY_REASON
        : await unavailableReason(tx, deps.blobs, teamId, project);
    return { project_id: project.projectId, access: project.access, available: !reason, reason };
  });
}

function ready(deps: NotesDeps): { blobs: BlobStore; keys: ApprovalKeyring } {
  if (!deps.keys) throw notAllowed(NO_KEY_REASON);
  if (!deps.blobs) throw new MemoryStorageError(STORAGE_REASON);
  return { blobs: deps.blobs, keys: deps.keys };
}

const changeOf = (who: MemoryWho, row: CandidateRow, plan: PlannedChange): NotesChange => ({
  teamId: workspaceOf(who),
  passId: row.passId,
  candidateId: row.id,
  userId: who.userId,
  projectId: plan.projectId,
  baseVersion: plan.baseVersion,
  line: plan.line,
});

export interface NotesPreview {
  readonly candidate_id: string;
  readonly project_id: string;
  readonly path: string;
  readonly section: "Learned";
  readonly base_version: number;
  readonly line: string;
  /** Warnings to show before approving (personal data and the like). */
  readonly warnings: readonly SemanticMemoryIssue[];
  /** The signed approval of this change, opaque: send it back to add. */
  readonly approval: string;
}

export function previewProjectNotes(
  deps: NotesDeps,
  who: MemoryWho,
  candidateId: string,
  body: z.infer<typeof notesPreviewSchema>,
): Promise<NotesPreview> {
  const { blobs, keys } = ready(deps);
  const teamId = workspaceOf(who);
  return withTeam(deps.db, teamId, async (tx) => {
    const row = await lockCandidate(tx, { teamId, userId: who.userId }, candidateId);
    const ids = { teamId, userId: who.userId, threadId: row.threadId };
    const plan = await planChange(tx, blobs, ids, body.statement ?? row.candidate.statement);
    return {
      candidate_id: row.id,
      project_id: plan.projectId,
      path: MEMORY_INDEX_FILE,
      section: "Learned",
      base_version: plan.baseVersion,
      line: plan.line,
      warnings: plan.warnings,
      approval: encodeNotesApproval(signNotesApproval(keys, changeOf(who, row, plan), new Date())),
    };
  });
}

export interface NotesAdded {
  readonly candidate_id: string;
  readonly project_id: string;
  readonly memory_doc_id: string;
  readonly version: number;
  readonly line: string;
}

const changed = (current?: number) =>
  new MemoryItemError(
    "memory_version_conflict",
    "The project's notes changed since you looked: add it again to see the change.",
    current && current > 0 ? { current_version: current } : {},
  );

export function addToProjectNotes(
  deps: NotesDeps,
  who: MemoryWho,
  candidateId: string,
  body: NotesAdd,
): Promise<NotesAdded> {
  const { blobs, keys } = ready(deps);
  const teamId = workspaceOf(who);
  return withTeam(deps.db, teamId, async (tx) => {
    const row = await lockCandidate(tx, { teamId, userId: who.userId }, candidateId);
    const statement = body.statement ?? row.candidate.statement;
    const ids = { teamId, userId: who.userId, threadId: row.threadId };
    const plan = await planChange(tx, blobs, ids, statement);
    if (plan.baseVersion !== body.base_version) throw changed(plan.baseVersion);
    const token = decodeNotesApproval(body.approval);
    const verdict = verifyNotesApproval(keys, token, changeOf(who, row, plan), new Date());
    if (verdict === "expired") throw inactive("The approval expired: add it again to approve.");
    if (verdict !== "ok")
      throw notAllowed("This approval doesn't cover this change: add it again.");
    const target = { scope: "project", projectId: plan.projectId } as const;
    const written = await writeMemory(
      tx,
      blobs,
      teamId,
      target,
      { path: MEMORY_INDEX_FILE, content: plan.content, expectedVersion: plan.baseVersion },
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
    await decideCandidate(tx, teamId, row.id, "saved", {
      op: "project_notes",
      project_id: plan.projectId,
      memory_doc_id: written.docId,
      version: written.version,
      batch: false,
    });
    await recordAudit(tx, {
      action: "memory.candidate.added_to_project",
      teamId,
      target: {
        candidateId: row.id,
        passId: row.passId,
        threadId: row.threadId,
        projectId: plan.projectId,
        memoryDocId: written.docId,
        version: written.version,
        edited: statement !== row.candidate.statement,
      },
    });
    await settleWhenDecided(tx, teamId, row.passId);
    return {
      candidate_id: row.id,
      project_id: plan.projectId,
      memory_doc_id: written.docId,
      version: written.version,
      line: plan.line,
    };
  });
}
