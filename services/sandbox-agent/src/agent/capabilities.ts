import {
  CAPABILITY_ARTIFACTS,
  CAPABILITY_APP_CARDS,
  CAPABILITY_MEMORY,
  CAPABILITY_SEMANTIC_MEMORY,
  CAPABILITY_SEMANTIC_MEMORY_PLACEMENT,
  CAPABILITY_FILES,
  CAPABILITY_PROJECTS,
  CAPABILITY_SKILL_DRAFTS,
  CAPABILITY_FILE_EDITS,
  CAPABILITY_NOTEBOOKS,
  CAPABILITY_NOTEBOOK_START,
  CAPABILITY_NOTEBOOK_INSPECT,
  CAPABILITY_RUN_TOKEN,
  CAPABILITY_THREAD_BRANCH_SUMMARY,
  CAPABILITY_THREAD_COMPACT,
  CAPABILITY_SYNC_CONFLICTS,
} from "@kobe/protocol";
import {
  CAPABILITY_MCP,
  CAPABILITY_SKILL_BUNDLES,
  CAPABILITY_TRACE_SPANS,
  CAPABILITY_SESSION_RENEW,
  CAPABILITY_SKILL_EVAL,
  CAPABILITY_WORKSPACE_MOVES,
  CAPABILITY_WORKSPACE_SYNC_NOW,
  CAPABILITY_THREAD_CONTEXT,
} from "@kobe/protocol/sandbox-wire";
import type { AgentDeps } from "./deps.js";

/**
 * Which optional tools and features this agent offers, from its deps alone. Every predicate
 * reduces to two inputs: the kobe-tools extension (the fd-4 channel) and what workspace sync
 * provides (plus kernels for notebooks).
 */
export interface Capabilities {
  readonly files: boolean;
  readonly projects: boolean;
  readonly projectCommits: boolean;
  readonly skillDrafts: boolean;
  readonly fileEdits: boolean;
  readonly notebookTools: boolean;
  readonly syncConflicts: boolean;
  readonly memory: boolean;
}

export function capabilitiesOf(deps: AgentDeps): Capabilities {
  return {
    files: filesEnabled(deps),
    projects: projectsEnabled(deps),
    projectCommits: projectCommitsEnabled(deps),
    skillDrafts: skillDraftsEnabled(deps),
    fileEdits: fileEditsEnabled(deps),
    notebookTools: notebookToolsEnabled(deps),
    syncConflicts: syncConflictsEnabled(deps),
    memory: memoryEnabled(deps),
  };
}

/**
 * `share_file` needs the tools channel (fd 4) and workspace sync (push-then-share): without
 * either this agent neither registers the tool nor announces `files`.
 */
function filesEnabled(deps: AgentDeps): boolean {
  return deps.toolsExtension !== undefined && deps.workspace?.pushPath !== undefined;
}

/** `commit_project` needs what `share_file` needs (the tools channel and workspace sync). */
function projectsEnabled(deps: AgentDeps): boolean {
  return filesEnabled(deps);
}

/** `commit_project` (KOBE-580) pushes the whole working copy first: projects plus a full push. */
function projectCommitsEnabled(deps: AgentDeps): boolean {
  return projectsEnabled(deps) && deps.workspace?.pushAll !== undefined;
}

/**
 * `propose_file_edit` (KOBE-462) needs only the tools channel: it pushes nothing. `open_file`
 * (KOBE-484) rides the same capability; it pushes when sync is on, else opens the synced copy.
 */
function fileEditsEnabled(deps: AgentDeps): boolean {
  return deps.toolsExtension !== undefined;
}

/** `run_python` (KOBE-464) needs a kernel and the tools channel. */
function notebookToolsEnabled(deps: AgentDeps): boolean {
  return deps.kernels !== undefined && deps.toolsExtension !== undefined;
}

/** `save_skill_draft` (KOBE-442) pushes the folder first, so it needs what `share_file` needs. */
function skillDraftsEnabled(deps: AgentDeps): boolean {
  return filesEnabled(deps);
}

/** Conflict reports (KOBE-492) need sync to see them and kobe-tools to tell the model. */
function syncConflictsEnabled(deps: AgentDeps): boolean {
  return deps.workspace?.onConflict !== undefined && deps.toolsExtension !== undefined;
}

/** `remember` / `recall` need the tools channel (fd 4); without it neither is registered nor announced. */
function memoryEnabled(deps: AgentDeps): boolean {
  return deps.toolsExtension !== undefined;
}

/** The capabilities `hello` announces, so the server sends their fields only to agents that can use them. */
export function helloCapabilities(deps: AgentDeps): string[] {
  const caps = capabilitiesOf(deps);
  return [
    ...(deps.skills === undefined ? [] : [CAPABILITY_SKILL_BUNDLES]),
    ...(deps.toolsExtension === undefined ? [] : [CAPABILITY_ARTIFACTS]),
    ...(caps.files ? [CAPABILITY_FILES] : []),
    ...(caps.projects ? [CAPABILITY_PROJECTS] : []),
    ...(caps.skillDrafts ? [CAPABILITY_SKILL_DRAFTS] : []),
    ...(caps.fileEdits ? [CAPABILITY_FILE_EDITS] : []),
    // Thread kernels (KOBE-464): the kernel commands, and `run_python` with the tools channel.
    // KOBE-803: run timing and variables snapshots (`notebook.inspect`, `with_timing`/`with_variables`).
    ...(deps.kernels === undefined
      ? []
      : [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_START, CAPABILITY_NOTEBOOK_INSPECT]),
    ...(caps.memory ? [CAPABILITY_MEMORY] : []),
    // What Kobe knows (KOBE-383): rendered from run.start.memory.semantic, so only with memory.
    ...(caps.memory ? [CAPABILITY_SEMANTIC_MEMORY] : []),
    // Memory placement (KOBE-658): picks beside the newest user message, held picks.
    ...(caps.memory ? [CAPABILITY_SEMANTIC_MEMORY_PLACEMENT] : []),
    // Per-session MCP config (KOBE-111) needs the proxy URL, a session to trade tokens with, and
    // Pi's MCP extension (built into Pi 1.0.x).
    ...(deps.mcp === undefined ? [] : [CAPABILITY_MCP]),
    // The run token reaches Pi through the models extension, so only with model wiring.
    ...(deps.models === undefined ? [] : [CAPABILITY_RUN_TOKEN]),
    // App cards (KOBE-440): appended to the session before the run, like the branch marker.
    CAPABILITY_APP_CARDS,
    // Compaction (KOBE-213) summarizes through the gateway with the run's token: same condition.
    ...(deps.models === undefined ? [] : [CAPABILITY_THREAD_COMPACT]),
    // Branch summaries (KOBE-548) go through kobe-models the same way.
    ...(deps.models === undefined ? [] : [CAPABILITY_THREAD_BRANCH_SUMMARY]),
    // Run spans over this wire (KOBE-274); sent only for runs the server gave a trace context.
    CAPABILITY_TRACE_SPANS,
    // Fresh session tokens handed to the live connection, so expiry never drops it (KOBE-483).
    CAPABILITY_SESSION_RENEW,
    // Server moves replayed as local renames (KOBE-304).
    ...(deps.workspace?.movedOnServer === undefined ? [] : [CAPABILITY_WORKSPACE_MOVES]),
    // Refresh in the Files panel pushes now and says when it is done (KOBE-599).
    ...(deps.workspace?.syncNow === undefined ? [] : [CAPABILITY_WORKSPACE_SYNC_NOW]),
    // Sync conflict copies reported, and the model told (KOBE-492).
    ...(caps.syncConflicts ? [CAPABILITY_SYNC_CONFLICTS] : []),
    // The latest model call's context for its owner (KOBE-470): read from Pi's capture or the
    // session file, so it needs nothing but the thread's files.
    CAPABILITY_THREAD_CONTEXT,
    // Skill eval fixtures in, workspace snapshot out (KOBE-325; sent only to eval sandboxes).
    ...(deps.skillEval === undefined ? [] : [CAPABILITY_SKILL_EVAL]),
  ];
}
