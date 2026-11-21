import { z } from "zod";
import { PROJECT_COMMIT_AUTHOR_KINDS } from "../../schema/projects.js";
import {
  agentScope,
  count,
  event,
  folderName,
  id,
  modelAlias,
  projectRole,
  projectRoleCounts,
  projectVisibility,
  purgeCounts,
  version,
  type AuditEventDef,
} from "./fragments.js";

export const THREADS_EVENTS = {
  // ── schedule: personal scheduled runs (KOBE-173, D32); ids only, never the prompt ──
  "schedule.created": event("team", { scheduleId: id, agentId: id, active: z.boolean() }),
  "schedule.updated": event("team", { scheduleId: id, agentId: id }),
  "schedule.deleted": event("team", { scheduleId: id }),
  /** `agent_available`: its lent agent is runnable again (KOBE-567, system). */
  "schedule.activated": event("team", {
    scheduleId: id,
    by: z.enum(["owner", "team_admin", "agent_available"]),
  }),
  /**
   * `deactivation` / `member_removed`: the owner was deactivated or left the team (KOBE-180,
   * system); `agent_unavailable`: its lent agent left the roster, was suspended or became
   * unavailable (KOBE-567, agents-roster AR11, system).
   */
  "schedule.deactivated": event("team", {
    scheduleId: id,
    by: z.enum(["owner", "team_admin", "deactivation", "member_removed", "agent_unavailable"]),
  }),

  // ── thread: lifecycle metadata only, never titles or content (KOBE-34, D18, D23) ──
  "thread.trashed": event("team", { threadId: id }),
  "thread.restored": event("team", { threadId: id }),
  /**
   * The owner changed the share scope (D23, CE20): `visibility` after the change, `from` before it
   * (KOBE-221; absent on older rows). `projectId` is the thread's project, null for a thread outside
   * any project (only the team scope needs none). Revoking is a change to `private`.
   */
  "thread.sharing_changed": event("team", {
    threadId: id,
    projectId: id.nullable(),
    shared: z.boolean(),
    visibility: z.enum(["private", "project", "team"]),
    from: z.enum(["private", "project", "team"]).optional(),
  }),
  /**
   * The owner moved the thread to another project, or out of one (null: no project; CE19,
   * KOBE-220). A thread shared to its old project is unshared too (`thread.sharing_changed`).
   */
  "thread.moved": event("team", { threadId: id, from: id.nullable(), to: id.nullable() }),
  /** A new private thread copied from `sourceThreadId`; `threadId` is the fork. */
  "thread.forked": event("team", {
    threadId: id,
    sourceThreadId: id,
    projectId: id.nullable(),
    entries: z.number().int().nonnegative(),
  }),
  /**
   * A member filed a thread they may read in a team folder or took it out of one (KOBE-534, TF3):
   * `from` and `to` are folder ids, null = no folder. Recorded only on a change.
   */
  "thread.filed": event("team", { threadId: id, from: id.nullable(), to: id.nullable() }),
  /** A member created a team thread folder (KOBE-534, TF4); `parentId` null = top level. */
  "thread_folder.created": event("team", {
    folderId: id,
    name: folderName,
    parentId: id.nullable(),
  }),
  /** A member renamed a team thread folder (KOBE-534). */
  "thread_folder.renamed": event("team", { folderId: id, from: folderName, to: folderName }),
  /** A member moved a team thread folder: `from` and `to` are parent ids, null = top level. */
  "thread_folder.moved": event("team", { folderId: id, from: id.nullable(), to: id.nullable() }),
  /**
   * A member deleted a team thread folder (KOBE-534): `folders` is how many subfolders went with
   * it, `threads` how many threads (any owner, Trash included) went back to no folder.
   */
  "thread_folder.deleted": event("team", {
    folderId: id,
    name: folderName,
    folders: z.number().int().nonnegative(),
    threads: z.number().int().nonnegative(),
  }),
  /**
   * The owner compacted the thread's Pi session (KOBE-213, CE15): the compaction run and how it
   * ended. Whether a focus was given, never its text (it is conversation content); absent when the
   * system ended the run (`timed_out` by the sweep, `interrupted` when its sandbox went away).
   */
  "thread.compacted": event("team", {
    threadId: id,
    runId: id,
    outcome: z.enum([
      "completed",
      "cancelled",
      "budget_stopped",
      "timed_out",
      "interrupted",
      "thread_busy",
      "sandbox_unavailable",
      "nothing_to_compact",
      "model_not_configured",
      "compaction_failed",
    ]),
    focused: z.boolean().optional(),
  }),
  /**
   * The owner made another branch current and carried a summary of the one left (KOBE-548, CT11):
   * the branch summary run and how it ended. Whether a focus was given, never its text; absent when
   * the system ended the run (`timed_out`, `interrupted`). Refusals before the run is created
   * (busy, reader, test thread, the cap) leave no row.
   */
  "thread.branch_summarized": event("team", {
    threadId: id,
    runId: id,
    outcome: z.enum([
      "completed",
      "cancelled",
      "budget_stopped",
      "timed_out",
      "interrupted",
      "thread_busy",
      "sandbox_unavailable",
      "nothing_to_summarize",
      "model_not_configured",
      "summary_failed",
    ]),
    focused: z.boolean().optional(),
  }),
  // ── project: configuration metadata only, never names, instructions or descriptions (KOBE-161, D23) ──
  /** `visibility` only on rows before KOBE-587 removed it (RV2). */
  "project.created": event("team", { projectId: id, visibility: projectVisibility.optional() }),
  /** `fields` lists which settings changed (names, not values). */
  "project.updated": event("team", { projectId: id, fields: z.array(z.string().max(40)).max(10) }),
  "project.deleted": event("team", { projectId: id }),
  "project.member_added": event("team", { projectId: id, userId: id, role: projectRole }),
  "project.member_removed": event("team", { projectId: id, userId: id }),
  /** A file joined the project (KOBE-162); `source` says whether a person uploaded it or an approved agent proposal added it. Never names or content. */
  "project.file_added": event("team", {
    projectId: id,
    fileId: id,
    source: z.enum(["upload", "proposal"]),
    sizeBytes: z.number().int().nonnegative(),
    /**
     * Add to project (KOBE-585): what was copied, by id only. An artifact version, or one of the
     * caller's own workspace files (no reference to it at all: never a name, path or hash of one).
     */
    importedFrom: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("artifact"), artifactId: id, version: count }),
        z.strictObject({ kind: z.literal("workspace_file") }),
      ])
      .optional(),
  }),
  "project.file_removed": event("team", { projectId: id, fileId: id }),
  /**
   * GV4: `roles` is the project's explicit role set after the change (how many owners and editors,
   * and readers on rows before KOBE-587; never names). Rows written before KOBE-577 name `member` and carry no `roles`.
   */
  "project.member_role_changed": event("team", {
    projectId: id,
    userId: id,
    from: projectRole,
    to: projectRole,
    roles: projectRoleCounts,
  }),
  // ── Workspaces (KOBE-577, GV4): ids, counts and kinds only, never paths, names or messages ──
  /** Retired by KOBE-587 (RV3): no longer written; rows written before it stay. */
  "project.visibility_changed": event("team", {
    projectId: id,
    from: projectVisibility,
    to: projectVisibility,
  }),
  /** PR5: an owner or a team admin handed the project to another member (now its owner). */
  "project.owner_transferred": event("team", {
    projectId: id,
    toUserId: id,
    fromUserId: id.nullable(),
  }),
  /** CM2: `baseSeq` null for a project with no commit yet. */
  "project.checked_out": event("team", { projectId: id, baseSeq: count.nullable() }),
  /**
   * CM5 Discard, the end of a member's checkouts when they leave (PJ3: `member_removed`), or when a
   * role change took away `edit` (KOBE-579: `access_lost`).
   */
  "project.checkout_discarded": event("team", {
    projectId: id,
    userId: id,
    reason: z.enum(["discarded", "member_removed", "access_lost"]),
  }),
  /**
   * CM5/CM6: a new head. `threadId`/`runId` for an agent's commit_project and for an accepted
   * proposal (KOBE-591, PE4: `source: "proposal"` with its `proposalId`, author the accepting member).
   */
  "project.committed": event("team", {
    projectId: id,
    commitId: id,
    seq: version,
    authorKind: z.enum(PROJECT_COMMIT_AUTHOR_KINDS),
    threadId: id.optional(),
    runId: id.optional(),
    source: z.enum(["proposal"]).optional(),
    proposalId: id.optional(),
    added: count,
    modified: count,
    deleted: count,
    fileCount: count,
    bytes: count,
  }),
  /** CM7: a new commit (`seq`) whose tree is the tree at `revertedSeq`. */
  "project.commit_reverted": event("team", {
    projectId: id,
    commitId: id,
    seq: version,
    revertedSeq: version,
  }),
  /** GV3: one retention sweep removed history of this project (counts; never the head). */
  "project.history_pruned": event("team", {
    projectId: id,
    commits: count,
    treeEntries: count,
    blobsQueued: count,
    rule: z.enum(["commits", "days", "hard_cap"]),
  }),
  /**
   * GV2/GV3/MT3 (KOBE-579): a team admin changed the workspace's storage settings; the values in
   * force afterwards (`maxObjects` null = the site default).
   */
  "project.storage_settings_changed": event("team", {
    historyKeep: z.union([
      z.strictObject({ mode: z.literal("all") }),
      z.strictObject({ mode: z.enum(["commits", "days"]), n: count }),
    ]),
    maxMountedPerMember: count,
    maxObjects: count.nullable(),
  }),
  /** The thread's chosen model changed (KOBE-44, D30); null = the team's default. */
  "thread.model_changed": event("team", {
    threadId: id,
    from: modelAlias.nullable(),
    to: modelAlias.nullable(),
  }),
  /** The thread's pinned agent version changed (D19 one-click switch, KOBE-46). */
  "thread.agent_switched": event("team", {
    threadId: id,
    agentId: id,
    scope: agentScope,
    fromVersion: version,
    toVersion: version,
  }),
  /** An agentless thread took the agent its owner picked (KOBE-458), at its current version. */
  "thread.agent_chosen": event("team", {
    threadId: id,
    agentId: id,
    scope: agentScope,
    version,
  }),

  /** The owner asked to delete a thread from Trash for good (D18); purged at once unless held. */
  "thread.purge_requested": event("team", { threadId: id }),
  /** One thread hard-deleted (the owner's "Delete forever"); counts of what went with it. */
  "thread.purged": event("team", { threadId: id, ...purgeCounts }),
  /**
   * The user downloaded their threads in the team (Pi JSONL + Markdown zip, D18); `memoryItems`:
   * their own semantic memories in it (KOBE-649; absent on older rows).
   */
  "thread.exported": event("team", {
    threads: count,
    entries: count,
    memoryItems: count.optional(),
  }),
  /** The owner downloaded one conversation as Markdown (`/export`, KOBE-450); a count, no text. */
  "thread.transcript_exported": event("team", { threadId: id, entries: count }),
  /** The owner turned a connector off or back on for one conversation (KOBE-451). */
  "thread.connector_toggled": event("team", {
    threadId: id,
    connectorId: id,
    enabled: z.boolean(),
  }),
} as const satisfies Record<string, AuditEventDef>;
