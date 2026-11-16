import {
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_LINES,
  type SemanticMemoryIssue,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../../retention/blobs.js";
import { projectMemoryAccess, type ProjectMemoryAccess } from "../access.js";
import { scanMemoryText } from "../checks.js";
import { MemoryItemError, inactive, invalid, notAllowed } from "../items/errors.js";
import { MemoryStorageError, listMemory, readCurrent } from "../store.js";
import { scopeEnabled } from "../switches.js";
import { appendLearned, fitsIndex, indexHasRoom, learnedLine } from "./learned.js";

/**
 * What Add to project notes (KOBE-398) writes to, read fresh in the caller's transaction: the
 * thread's project now (never a stored one: a thread moved out of its project stales the
 * action, PE5), the caller's role in it (`edit`: editor, owner, Team admin), the project memory
 * switches, and `MEMORY.md` as it is (content and version). The same reads serve the panel's
 * status, the preview the person approves, and the write at click.
 */

export const READER_REASON =
  "Only the project's editors, owners and Team admins add to its notes: suggest it to them " +
  "instead.";
export const DISABLED_REASON = "Project memory is turned off.";
export const FULL_REASON = `The project's ${MEMORY_INDEX_FILE} is full (${MEMORY_INDEX_MAX_LINES} lines): make room in its Notes first.`;
export const STORAGE_REASON = "Notes storage is not available.";
export const NO_KEY_REASON = "Project notes need the site's approval key: ask a site admin.";

export interface ThreadProject {
  readonly projectId: string;
  readonly access: Exclude<ProjectMemoryAccess, "none">;
}

/** The thread's project and the caller's access to its memory; null: none or not visible. */
export async function threadProject(
  tx: KobeTx,
  ids: { teamId: string; userId: string; threadId: string },
): Promise<ThreadProject | null> {
  const { rows } = await tx.execute<{ project_id: string | null }>(sql`
    SELECT project_id FROM threads WHERE team_id = ${ids.teamId} AND id = ${ids.threadId}`);
  const projectId = rows[0]?.project_id ?? null;
  if (projectId === null) return null;
  const access = await projectMemoryAccess(tx, ids.teamId, ids.userId, projectId);
  return access === "none" ? null : { projectId, access };
}

export interface IndexState {
  readonly content: string;
  /** 0: no `MEMORY.md` yet. */
  readonly version: number;
}

export async function readIndex(
  tx: KobeTx,
  blobs: BlobStore,
  teamId: string,
  projectId: string,
): Promise<IndexState> {
  const docs = await listMemory(tx, teamId, { scope: "project", projectId });
  const doc = docs.find((d) => d.path === MEMORY_INDEX_FILE);
  if (!doc) return { content: "", version: 0 };
  const content = await readCurrent(tx, blobs, teamId, doc);
  if (content === null) throw new MemoryStorageError("project MEMORY.md is unavailable");
  return { content, version: doc.currentVersion };
}

/** Why the action can't run now (null: it can), for the card. */
export async function unavailableReason(
  tx: KobeTx,
  blobs: BlobStore | undefined,
  teamId: string,
  project: ThreadProject,
): Promise<string | null> {
  if (!(await scopeEnabled(tx, teamId, "project"))) return DISABLED_REASON;
  // A reader suggests it to the editors instead (KOBE-652): nothing else stands in the way.
  if (project.access !== "write") return null;
  if (!blobs) return STORAGE_REASON;
  return indexHasRoom((await readIndex(tx, blobs, teamId, project.projectId)).content)
    ? null
    : FULL_REASON;
}

export interface PlannedChange {
  readonly projectId: string;
  readonly baseVersion: number;
  readonly line: string;
  /** `MEMORY.md` with the line added. */
  readonly content: string;
  /** Shared-scope warnings (personal data, links) shown on the card; never instruction lint. */
  readonly warnings: readonly SemanticMemoryIssue[];
}

/**
 * Project notes are shared and the text is model-generated: the Workspace item rules apply
 * (personal data and instruction lint). Secrets and lint hits refuse, as a Workspace save without
 * an override would; the other warnings (returned) travel to the card. Also run on a reader's
 * suggestion (KOBE-652) when it is made, and again when an editor approves it.
 */
export function scanSharedLine(statement: string): readonly SemanticMemoryIssue[] {
  const scan = scanMemoryText({ scope: "team", policy: false, statement });
  if (scan.invalid !== null) throw invalid(scan.invalid);
  if (scan.secret !== null)
    throw new MemoryItemError(
      "memory_secret",
      `This looks like ${scan.secret.label}. Remove it: secrets can never be saved in memory.`,
    );
  const lint = scan.warnings.filter((w) => w.code.startsWith("instruction_"));
  if (lint.length > 0)
    throw new MemoryItemError(
      "memory_lint_warning",
      "This reads like an instruction to the agent, so it can't go into the project's notes.",
      { warnings: lint },
    );
  return scan.warnings.filter((w) => !w.code.startsWith("instruction_"));
}

/** Every check at click, then the exact change. Throws the refusal the person sees. */
export async function planChange(
  tx: KobeTx,
  blobs: BlobStore,
  ids: { teamId: string; userId: string; threadId: string },
  statement: string,
): Promise<PlannedChange> {
  const project = await threadProject(tx, ids);
  if (!project) throw inactive("This conversation is no longer in a project you can see.");
  if (project.access !== "write") throw notAllowed(READER_REASON);
  if (!(await scopeEnabled(tx, ids.teamId, "project")))
    throw new MemoryItemError("memory_disabled", DISABLED_REASON);
  const warnings = scanSharedLine(statement);
  const index = await readIndex(tx, blobs, ids.teamId, project.projectId);
  const line = learnedLine(statement);
  const content = appendLearned(index.content, line);
  if (!fitsIndex(content)) throw new MemoryItemError("memory_scope_full", FULL_REASON);
  return { projectId: project.projectId, baseVersion: index.version, line, content, warnings };
}
