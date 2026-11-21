import { z } from "zod";
import { count, event, id, toolCallId, type AuditEventDef } from "./fragments.js";
import {
  ARTIFACT_PUT_REFUSALS,
  FILE_SHARE_REFUSALS,
  MEMORY_REFUSALS,
  PROJECT_FILE_REFUSALS,
  SANDBOX_LIMITS,
  SKILL_DRAFT_REFUSALS,
  WEB_SEARCH_REFUSALS,
} from "./vocab.js";

export const SANDBOX_WIRE_EVENTS = {
  // ── sandbox: the sandbox wire (KOBE-24, D13); throttled per sandbox and violation ──
  /** A sandbox named a run, thread or command not leased to its connection (closed; system). */
  "sandbox.lease_violation": event("team", {
    sandboxId: id,
    userId: id,
    violation: z.enum(["unknown_run", "unknown_thread", "unknown_command"]),
    frameType: z.string().regex(/^[a-z][a-z_.]{0,31}$/),
  }),
  /**
   * A validly signed `kobe.sandbox-wire` token was refused: the sandbox is no longer live, its user
   * may not use it (deactivated, left the team), or `hello` named another sandbox (system).
   * Unsigned/forged tokens carry no trustworthy team and are only logged and counted.
   */
  "sandbox.token_rejected": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(["not_live", "not_allowed", "sandbox_mismatch"]),
  }),
  /**
   * The sandbox agent found Pi's private runtime changed by another process and stopped that Pi;
   * the run (a message's `run.start` or a compaction) failed `runtime_tampered` (KOBE-271).
   * Written with the run's failure, once per run; ids only, never the agent's reason (system).
   */
  "sandbox.runtime_tampered": event("team", {
    sandboxId: id,
    userId: id,
    threadId: id,
    runId: id,
    runKind: z.enum(["message", "compaction", "branch_summary"]),
    /** The server replica holding the sandbox's connection. */
    replicaId: id,
  }),
  /** A sandbox exceeded a wire or storage limit; connection closed or run stopped (system). */
  "sandbox.limit_exceeded": event("team", {
    sandboxId: id,
    userId: id,
    limit: z.enum(SANDBOX_LIMITS),
    runId: id.optional(),
  }),

  /**
   * The server refused an `artifact.put` (KOBE-129, D3 of KOBE-55): a connection without the
   * capability, a run not active here, a tool call it did not allow (or with another input), or an
   * update of an artifact outside the call's team and thread. Never records content (system;
   * at most one per 5 minutes per reason and user).
   */
  "sandbox.artifact_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(ARTIFACT_PUT_REFUSALS),
    tool: z.enum(["create_artifact", "update_artifact"]),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * The server refused a `file.share` (KOBE-150): no `files` capability, a run not active here, a
   * tool call it did not allow (or other input), a workspace entry that does not match the push,
   * or a size / quota / scan refusal. Never records names, paths or content (system; at most one
   * per 5 minutes per reason and user).
   */
  "sandbox.file_share_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(FILE_SHARE_REFUSALS),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * The server refused a `skill.draft_save` (KOBE-442): no `skill_drafts` capability, a run not
   * active here, a `save_skill_draft` call it did not allow (or other input), a file outside the
   * folder or not as pushed, or a draft refusal (validation, limits, rate). Never records names,
   * paths or content (system; at most one per 5 minutes per reason and user).
   */
  "sandbox.skill_draft_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(SKILL_DRAFT_REFUSALS),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * The server refused a `project.file_propose` (KOBE-162): no `projects` capability, a run not
   * active here, a `propose_project_file` call it did not allow (or other input), a thread outside
   * a project, a user who is not a project member, a workspace entry that does not match the push,
   * a size / quota / duplicate refusal, or an approval that was denied or lapsed. Never records
   * names, paths or content (system; at most one per 5 minutes per reason and user).
   */
  "sandbox.project_file_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(PROJECT_FILE_REFUSALS),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * The server refused a `web_search.query` (KOBE-114): no `web_search` capability, a run not
   * active here, or a tool call it did not allow (or other input). Never records the query (system;
   * at most one per 5 minutes per reason and user).
   * Retired by KOBE-606 (built-in web search removed): no longer written; rows written before it stay.
   */
  "sandbox.web_search_refused": event("team", {
    sandboxId: id,
    userId: id,
    reason: z.enum(WEB_SEARCH_REFUSALS),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  /**
   * A `web_search` reached the provider (KOBE-114). Counts toward the per-run cap, read back from
   * this table under a per-run lock, so it holds across replicas. Never records the query (system).
   * Retired by KOBE-606: no longer written; rows written before it stay.
   */
  "sandbox.web_search_queried": event("team", {
    sandboxId: id,
    userId: id,
    runId: id,
    toolCallId,
    provider: z.enum(["brave", "tavily", "exa"]),
  }),

  /**
   * The server refused a `memory.put` or `memory.read` (KOBE-156): no `memory` capability, a run
   * not active here, a `remember` call it did not allow (or other input), a disabled scope, a
   * thread outside a project, a user who is not a project member, or a project write whose
   * approval was denied or lapsed. Never records paths or content (system; at most one per 5
   * minutes per reason and user).
   */
  "sandbox.memory_refused": event("team", {
    sandboxId: id,
    userId: id,
    op: z.enum(["put", "read"]),
    reason: z.enum(MEMORY_REFUSALS),
    scope: z.enum(["user", "project"]).optional(),
    runId: id.optional(),
    toolCallId: toolCallId.optional(),
  }),

  // ── workspace: the durable S3 copy of each sandbox's /workspace (KOBE-27, D12, D15, D26) ──
  /**
   * A sandbox restored its workspace onto an empty volume from the durable copy (rebuild after a
   * lost or new volume). Counts are the sandbox's own report (system actor).
   */
  "workspace.restored": event("team", {
    sandboxId: id,
    userId: id,
    files: count,
    bytes: count,
    durationMs: count,
  }),
  /**
   * A sandbox uploaded bytes that did not hash to the name it gave them (tampered or broken;
   * nothing stored). One row per sandbox per minute at most; `failures` counts every mismatch
   * since the previous row, so none is hidden by the throttle (system).
   */
  "workspace.integrity_failed": event("team", {
    sandboxId: id,
    userId: id,
    failures: z.number().int().positive(),
  }),
  /** A workspace file was copied to a durable shared object (KOBE-54 `share_file`). */
  "workspace.file_shared": event("team", { userId: id, sharedId: id, bytes: count }),
  // ── files: user uploads (KOBE-143, 53c of KOBE-53); counts and ids only, never names or content ──
  /** A file was stored (S3 first, then the `files` row). `threadId` absent: not in a thread yet. */
  "workspace.upload_stored": event("team", {
    userId: id,
    fileId: id,
    threadId: id.optional(),
    bytes: count,
  }),
  /** An upload was refused (`bytes` seen before the refusal; 0 when refused up front). */
  "workspace.upload_refused": event("team", {
    userId: id,
    reason: z.enum(["file_too_large", "message_too_large", "quota_exceeded"]),
    bytes: count,
  }),
  /**
   * The virus scan (ClamAV, KOBE-146) rejected an upload, or was unreachable while scanning is on
   * (`reason`); the object was deleted. Counts only: no name, content or signature.
   */
  "workspace.upload_scan_refused": event("team", {
    userId: id,
    reason: z.enum(["scan_rejected", "scan_unavailable"]),
    bytes: count,
  }),
  /** Uploads never attached to a thread within the retention window were deleted (system). */
  "workspace.uploads_expired": event("team", { files: count, bytes: count }),
  /** The user downloaded a file of their own workspace in the file browser (KOBE-148; no names). */
  "workspace.file_downloaded": event("team", { userId: id, bytes: count }),
  /** The user uploaded a file into their own workspace in the file browser (KOBE-148; no names). */
  // `area: "drop"`: a file dropped on the rail into uploads/ (KOBE-199). `area: "artifact"`: Edit as
  // file copied an artifact version into artifacts/ (KOBE-485), named by its ids only.
  "workspace.file_uploaded": event("team", {
    userId: id,
    bytes: count,
    area: z.enum(["drop", "artifact"]).optional(),
    artifactId: id.optional(),
    version: count.optional(),
  }),
  /**
   * The user saved an edited file of their own workspace from the file editor (KOBE-462): the new
   * size only, never a name or content.
   */
  "workspace.file_saved": event("team", { userId: id, bytes: count }),
  /** The user deleted a file or folder of their own workspace in the file browser (KOBE-148). */
  "workspace.file_deleted": event("team", { userId: id, files: count, bytes: count }),
  /**
   * The user moved or renamed a file or folder of their own workspace in the file browser
   * (KOBE-304): counts only, never a name or path.
   */
  "workspace.file_moved": event("team", { userId: id, files: count, bytes: count }),
  /**
   * The sandbox's sync kept the member's version of a file and moved the agent's unsynced edit to a
   * conflict copy (KOBE-492; system: the member's sandbox reported it). Ids only, never a name.
   * `threadId`/`runId`: the thread and run that last wrote the path, when one did.
   */
  "workspace.sync_conflict": event("team", {
    userId: id,
    conflictId: id,
    threadId: id.optional(),
    runId: id.optional(),
  }),
  /** Unreferenced workspace blobs and old tombstones were purged (system; counts only, D18). */
  "workspace.purged": event("team", { userId: id, blobs: count, bytes: count, tombstones: count }),

  // ── sandbox offboarding: a departed member's sandbox and volume (D12, KOBE-28) ──
  /**
   * A member's sandbox in a team was destroyed because the member was removed, deactivated or the
   * team removed (actor: the admin who did it, else the platform). The workspace volume is kept
   * until `retainUntil` (30 days) so a team admin can export it.
   */
  "sandbox.offboarded": event("team", {
    userId: id,
    sandboxId: id.optional(),
    trigger: z.enum(["member_removed", "deactivated", "team_removed", "reconciled"]),
    volumeKept: z.boolean(),
    retainUntil: z.iso.datetime({ offset: true }),
  }),
  /** A team admin downloaded the zip export of a departed member's workspace (counts only). */
  "sandbox.export_downloaded": event("team", { userId: id, files: count, bytes: count }),
  /**
   * The retention sweep deleted a departed member's volume and workspace copy after the 30 days
   * (system; never while a legal hold covers the member in the team). Counts only.
   */
  "sandbox.volume_deleted": event("team", {
    userId: id,
    volumeDeleted: z.boolean(),
    files: count,
    blobs: count,
    bytes: count,
  }),
} as const satisfies Record<string, AuditEventDef>;
