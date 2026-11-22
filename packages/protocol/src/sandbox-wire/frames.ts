import { z } from "zod";
import {
  memoryPutFrameSchema,
  memoryReadFrameSchema,
  memoryResultFrameSchema,
  memoryShowFrameSchema,
} from "./memory-frames.js";
import { projectCommitFrameSchema, projectCommitResultFrameSchema } from "./project-frames.js";
import {
  legacyWebSearchQueryFrameSchema,
  legacyWebSearchResultFrameSchema,
} from "./legacy-web-search-frames.js";
import { traceSpansFrameSchema } from "./trace-frames.js";
import {
  evalPrepareFrameSchema,
  evalReadFrameSchema,
  evalSnapshotFrameSchema,
} from "./eval-frames.js";
import { threadContextFrameSchema } from "./context-frames.js";
import { sessionRenewFrameSchema } from "./session-renew-frames.js";
import {
  skillDraftSaveFrameSchema,
  skillDraftSaveResultFrameSchema,
} from "./skill-draft-frames.js";
import {
  workspaceSyncedFrameSchema,
  workspaceSyncNowFrameSchema,
} from "./workspace-sync-now-frames.js";
import {
  fileEditProposeFrameSchema,
  fileEditProposeResultFrameSchema,
} from "./file-edit-frames.js";
import {
  workspaceConflictFrameSchema,
  workspaceConflictNoteFrameSchema,
} from "./sync-conflict-frames.js";
import { fileOpenFrameSchema, fileOpenResultFrameSchema } from "./file-open-frames.js";
import {
  notebookExecuteFrameSchema,
  notebookInspectFrameSchema,
  notebookInterruptFrameSchema,
  notebookOutputFrameSchema,
  notebookRestartFrameSchema,
  notebookRunFrameSchema,
  notebookRunResultFrameSchema,
} from "./notebook-frames.js";
import {
  artifactPutFrameSchema,
  artifactResultFrameSchema,
  fileShareFrameSchema,
  fileShareResultFrameSchema,
} from "./frames/artifacts-files.js";
import {
  threadBranchSummaryFrameSchema,
  threadBranchSummaryResultFrameSchema,
  threadCompactFrameSchema,
  threadCompactResultFrameSchema,
} from "./frames/compaction.js";
import {
  policyCheckFrameSchema,
  policyPendingFrameSchema,
  policyResultFrameSchema,
} from "./frames/policy.js";
import { runStartFrameSchema, runSteerFrameSchema, runStopFrameSchema } from "./frames/run.js";
import {
  ackFrameSchema,
  commandResultFrameSchema,
  helloAckFrameSchema,
  helloFrameSchema,
  piCommandFrameSchema,
  piEventFrameSchema,
  piExitedFrameSchema,
  piUiRequestFrameSchema,
  piUiResponseFrameSchema,
  resendFrameSchema,
  sessionRestoreFrameSchema,
  shutdownFrameSchema,
  workspaceMovedFrameSchema,
} from "./frames/session.js";
import { errorFrame, pingFrame, pongFrame, serverErrorFrame } from "./frames/wire.js";

/**
 * Frame schemas for both directions. Semantics are documented in connection.ts. The frames live in
 * `frames/*` by domain; this module holds the two unions, so it imports every frame (KOBE-720).
 */

export { OPEN_CODE_PATTERN } from "./frames/wire.js";
export * from "./frames/artifacts-files.js";
export * from "./frames/compaction.js";
export * from "./frames/model.js";
export * from "./frames/policy.js";
export * from "./frames/run.js";
export * from "./frames/session.js";

export const sandboxToServerFrameSchema = z.union([
  helloFrameSchema,
  piEventFrameSchema,
  piUiRequestFrameSchema,
  policyCheckFrameSchema,
  commandResultFrameSchema,
  threadCompactResultFrameSchema,
  threadBranchSummaryResultFrameSchema,
  artifactPutFrameSchema,
  fileShareFrameSchema,
  memoryPutFrameSchema,
  memoryReadFrameSchema,
  memoryShowFrameSchema,
  projectCommitFrameSchema,
  skillDraftSaveFrameSchema,
  fileEditProposeFrameSchema,
  fileOpenFrameSchema,
  workspaceConflictFrameSchema,
  workspaceSyncedFrameSchema,
  notebookOutputFrameSchema,
  notebookRunFrameSchema,
  legacyWebSearchQueryFrameSchema, // retired (KOBE-606): answered unavailable
  traceSpansFrameSchema,
  sessionRenewFrameSchema,
  piExitedFrameSchema,
  pingFrame,
  pongFrame,
  errorFrame,
]);
export type SandboxToServerFrame = z.infer<typeof sandboxToServerFrameSchema>;

export const serverToSandboxFrameSchema = z.union([
  helloAckFrameSchema,
  runStartFrameSchema,
  runSteerFrameSchema,
  runStopFrameSchema,
  piCommandFrameSchema,
  threadCompactFrameSchema,
  threadBranchSummaryFrameSchema,
  evalPrepareFrameSchema,
  evalSnapshotFrameSchema,
  evalReadFrameSchema,
  threadContextFrameSchema,
  piUiResponseFrameSchema,
  policyPendingFrameSchema,
  policyResultFrameSchema,
  artifactResultFrameSchema,
  fileShareResultFrameSchema,
  memoryResultFrameSchema,
  projectCommitResultFrameSchema,
  skillDraftSaveResultFrameSchema,
  fileEditProposeResultFrameSchema,
  fileOpenResultFrameSchema,
  workspaceConflictNoteFrameSchema,
  notebookRunResultFrameSchema,
  notebookExecuteFrameSchema,
  notebookInterruptFrameSchema,
  notebookRestartFrameSchema,
  notebookInspectFrameSchema,
  legacyWebSearchResultFrameSchema, // retired (KOBE-606)
  sessionRestoreFrameSchema,
  ackFrameSchema,
  resendFrameSchema,
  shutdownFrameSchema,
  workspaceMovedFrameSchema,
  workspaceSyncNowFrameSchema,
  pingFrame,
  pongFrame,
  serverErrorFrame,
]);
export type ServerToSandboxFrame = z.infer<typeof serverToSandboxFrameSchema>;

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type HelloAckFrame = z.infer<typeof helloAckFrameSchema>;
export type PiEventFrame = z.infer<typeof piEventFrameSchema>;
export type PolicyCheckFrame = z.infer<typeof policyCheckFrameSchema>;
export type ArtifactPutFrame = z.infer<typeof artifactPutFrameSchema>;
export type ArtifactResultFrame = z.infer<typeof artifactResultFrameSchema>;
export type FileShareFrame = z.infer<typeof fileShareFrameSchema>;
export type FileShareResultFrame = z.infer<typeof fileShareResultFrameSchema>;
export type ProjectCommitFrame = z.infer<typeof projectCommitFrameSchema>;
export type ProjectCommitResultFrame = z.infer<typeof projectCommitResultFrameSchema>;
export type LegacyWebSearchQueryFrame = z.infer<typeof legacyWebSearchQueryFrameSchema>;
export type LegacyWebSearchResultFrame = z.infer<typeof legacyWebSearchResultFrameSchema>;
export type MemoryPutFrame = z.infer<typeof memoryPutFrameSchema>;
export type MemoryReadFrame = z.infer<typeof memoryReadFrameSchema>;
export type MemoryShowFrame = z.infer<typeof memoryShowFrameSchema>;
export type MemoryResultFrame = z.infer<typeof memoryResultFrameSchema>;
export type PolicyResultFrame = z.infer<typeof policyResultFrameSchema>;
export type RunStartFrame = z.infer<typeof runStartFrameSchema>;
export type RunStopFrame = z.infer<typeof runStopFrameSchema>;
export type CommandResultFrame = z.infer<typeof commandResultFrameSchema>;
export type ThreadCompactFrame = z.infer<typeof threadCompactFrameSchema>;
export type ThreadCompactResultFrame = z.infer<typeof threadCompactResultFrameSchema>;
export type ThreadBranchSummaryFrame = z.infer<typeof threadBranchSummaryFrameSchema>;
export type ThreadBranchSummaryResultFrame = z.infer<typeof threadBranchSummaryResultFrameSchema>;
