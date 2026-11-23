import type { AuditEventDoc } from "./fragments.js";
import type { THREADS_EVENTS } from "./threads.js";

/**
 * The docs/audit-log.md rows of the threads area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in name order.
 */
export const THREADS_EVENT_DOCS = {
  "project.checked_out": {
    fields: "`projectId`, `baseSeq` (null for a project with no commit)",
    when: "A member checked a project out to edit it (CM2)",
  },
  "project.checkout_discarded": {
    fields:
      "`projectId`, `userId`, `reason` (discarded, member_removed, access_lost, project_deleted)",
    when: "A working copy ended without a commit (CM5 Discard, or the member left the workspace or was deactivated, PJ3/MT4; deactivation is recorded with the system actor, KOBE-578; or a role change took away edit, `access_lost`, KOBE-579); or the project was deleted, `project_deleted`, KOBE-780",
  },
  "project.commit_reverted": {
    fields: "`projectId`, `commitId`, `seq`, `revertedSeq`",
    when: "A revert wrote a new commit equal to the tree at `revertedSeq` (CM7)",
  },
  "project.committed": {
    fields:
      "`projectId`, `commitId`, `seq`, `authorKind` (user, agent), `threadId?`, `runId?`, `source?` (proposal), `proposalId?`, `added`, `modified`, `deleted`, `fileCount`, `bytes`",
    when: "A commit became the project head (CM5, CM6; an accepted agent proposal, KOBE-591); never paths, names, messages or content",
  },
  "project.created": {
    fields:
      "`projectId`; rows before KOBE-587 also carry `visibility` (workspace, restricted), rows before KOBE-577 `membersMode`",
    when: "Project created (D23, KOBE-161); never its name or instructions",
  },
  "project.deleted": {
    fields:
      "`projectId`, `workingCopies`, `uncommittedWorkingCopies` (KOBE-780; absent on older rows)",
    when: "Project deleted (refused while threads, memory or files remain)",
  },
  "project.file_added": {
    fields:
      "`projectId`, `fileId`, `source` (upload; proposal on rows from before WS-7, the agent no longer proposes files), `sizeBytes`; `importedFrom` for Add to project (`{kind: artifact, artifactId, version}` or `{kind: workspace_file}`, no path or hash, KOBE-585)",
    when: "A file joined a project (KOBE-162); an agent proposal only after its signed approval (before WS-7); never names or content; Add to project (KOBE-585) copies an artifact version or the caller's own workspace file",
  },
  "project.file_removed": {
    fields: "`projectId`, `fileId`",
    when: "A file left a project (KOBE-162)",
  },
  "project.history_pruned": {
    fields:
      "`projectId`, `commits`, `treeEntries`, `blobsQueued`, `rule` (commits, days, hard_cap)",
    when: "A retention sweep removed project history (GV3); never the head, a checkout base or held history",
  },
  "project.member_added": {
    fields: "`projectId`, `userId`, `role`",
    when: "Member added to a project",
  },
  "project.member_removed": {
    fields: "`projectId`, `userId`",
    when: "Member removed from a project",
  },
  "project.member_role_changed": {
    fields:
      "`projectId`, `userId`, `from`, `to` (owner, editor; reader on rows before KOBE-587), `roles` (`{owner, editor}` counts after the change, plus `reader` on rows before KOBE-587; rows before KOBE-577 say `member` and have no `roles`)",
    when: "Project role changed (GV4)",
  },
  "project.owner_transferred": {
    fields:
      "`projectId`, `toUserId`, `fromUserId` (the handing owner; null when a team admin assigned)",
    when: "Ownership handed to another member by an owner (who becomes editor; `fromUserId` = the owner) or assigned by a team admin (`fromUserId` null, nobody demoted) (PR5, KOBE-578)",
  },
  "project.storage_settings_changed": {
    fields:
      "`historyKeep` (mode all, or commits or days with n), `maxMountedPerMember`, `maxObjects` (null = site default)",
    when: "A team admin changed the workspace storage settings (GV2, GV3, MT3; KOBE-579): the values in force afterwards",
  },
  "project.updated": {
    fields: "`projectId`, `fields` (names of the changed settings)",
    when: "Project settings changed; values (instructions, description) are not audited",
  },
  "project.visibility_changed": {
    fields: "`projectId`, `from`, `to` (workspace, restricted)",
    when: "**Retired** (KOBE-587): no longer written, since every workspace member reads every project; rows written before stay. Project visibility changed (Workspaces PR2, KOBE-577)",
  },
  "schedule.activated": {
    fields: "`scheduleId`, `by` (owner, team_admin, agent_available)",
    when: "Schedule resumed; `agent_available` (system): its lent agent is runnable again (KOBE-567)",
  },
  "schedule.created": {
    fields: "`scheduleId`, `agentId`, `active`",
    when: "Personal schedule created (KOBE-173)",
  },
  "schedule.deactivated": {
    fields:
      "`scheduleId`, `by` (owner, team_admin, deactivation, member_removed, agent_unavailable)",
    when: "Schedule paused; `deactivation`/`member_removed` (system): the owner was deactivated or left the team (KOBE-180); `agent_unavailable` (system): its lent agent left the roster, was suspended or became unavailable (KOBE-567)",
  },
  "schedule.deleted": { fields: "`scheduleId`", when: "Schedule deleted" },
  "schedule.updated": {
    fields: "`scheduleId`, `agentId`",
    when: "Prompt, recurrence, timezone, agent or email setting changed",
  },
  "thread.agent_chosen": {
    fields: "`threadId`, `agentId`, `scope`, `version`",
    when: "An agentless thread took the agent its owner picked, at its current version (KOBE-458)",
  },
  "thread.agent_switched": {
    fields: "`threadId`, `agentId`, `scope`, `fromVersion`, `toVersion`",
    when: "Thread pinned to another version of its agent (D19 one-click switch)",
  },
  "thread.branch_summarized": {
    fields:
      "`threadId`, `runId` (the branch summary run), `outcome` (`completed`, `cancelled`, `budget_stopped`, `timed_out`, `interrupted`, or the error code), `focused` (whether a focus was given, never its text; absent when the system ended it)",
    when: "The owner made another branch current and carried a summary of the branch left (CT11, KOBE-548); refusals before the run starts leave no row",
  },
  "thread.compacted": {
    fields:
      "`threadId`, `runId` (the compaction run), `outcome` (`completed`, `cancelled`, `budget_stopped`, `timed_out`, `interrupted`, or the error code), `focused` (whether a focus was given, never its text; absent when the system ended it)",
    when: "The owner compacted the thread's Pi session with Compact now (CE15, KOBE-213)",
  },
  "thread.connector_toggled": {
    fields: "`threadId`, `connectorId`, `enabled`",
    when: "The owner turned a connector off or back on for one conversation (the composer's + menu, KOBE-451)",
  },
  "thread.exported": {
    fields: "`threads`, `entries`, `memoryItems`",
    when: "The user downloaded their threads in the team (Pi JSONL + Markdown zip, D18; counts only, KOBE-18; `memoryItems`: their own semantic memories in it, KOBE-649)",
  },
  "thread.filed": {
    fields: "`threadId`, `from`, `to` (folder ids; null = no folder)",
    when: "A member who may read the thread (owner, or D23/CE20 reader) filed it in a team folder or took it out of one (KOBE-534, TF3); only on a change",
  },
  "thread.forked": {
    fields: "`threadId` (the fork), `sourceThreadId`, `projectId`, `entries` (count copied)",
    when: "New private thread copied from a thread the caller may read (D23)",
  },
  "thread.model_changed": {
    fields: "`threadId`, `from`, `to` (aliases; null = the team default)",
    when: "The thread's owner chose another model for its next runs (KOBE-44)",
  },
  "thread.moved": {
    fields: "`threadId`, `from`, `to` (project ids; null = no project)",
    when: "The owner moved the thread to another project or out of one (CE19, KOBE-220); a thread shared to its old project is also unshared (`thread.sharing_changed`)",
  },
  "thread.purge_requested": {
    fields: "`threadId`",
    when: 'The owner chose "Delete forever" in Trash (D18): the thread leaves Trash at once; purged now unless a legal hold keeps it (KOBE-18)',
  },
  "thread.purged": {
    fields: "`threadId`, `entries`, `runs`, `events`, `blobs`, `appResults?`",
    when: "One thread hard-deleted at its owner's request, with counts of what went with it (KOBE-18)",
  },
  "thread.restored": { fields: "`threadId`", when: "Thread restored from Trash" },
  "thread.sharing_changed": {
    fields:
      "`threadId`, `projectId` (null outside a project), `shared`, `visibility` and `from` (private, project, team; `from` since KOBE-221)",
    when: "The owner shared the thread with its project or the team, changed the scope, or revoked it (`visibility` private) (D23, CE20)",
  },
  "thread.transcript_exported": {
    fields: "`threadId`, `entries`",
    when: "The owner downloaded one conversation as Markdown (`/export`, KOBE-450; a count only, never its text)",
  },
  "thread.trashed": { fields: "`threadId`", when: "Thread moved to Trash (D18 soft delete)" },
  "thread_folder.created": {
    fields: "`folderId`, `name`, `parentId` (null = top level)",
    when: "A member created a team thread folder (KOBE-534, TF4)",
  },
  "thread_folder.deleted": {
    fields:
      "`folderId`, `name`, `folders` (subfolders deleted with it), `threads` (threads taken out of the deleted folders)",
    when: "A member deleted a team thread folder and its subfolders; their threads go back to no folder",
  },
  "thread_folder.moved": {
    fields: "`folderId`, `from`, `to` (parent ids; null = top level)",
    when: "A member moved a team thread folder; a position change alone is not audited",
  },
  "thread_folder.renamed": {
    fields: "`folderId`, `from`, `to` (names)",
    when: "A member renamed a team thread folder",
  },
} satisfies Record<keyof typeof THREADS_EVENTS, AuditEventDoc>;
