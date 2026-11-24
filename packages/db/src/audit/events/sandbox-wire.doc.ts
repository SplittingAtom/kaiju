import type { AuditEventDoc } from "./fragments.js";
import type { SANDBOX_WIRE_EVENTS } from "./sandbox-wire.js";

/**
 * The docs/audit-log.md rows of the sandbox-wire area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kaiju/db audit:doc`). Add an event's row here in name order.
 */
export const SANDBOX_WIRE_EVENT_DOCS = {
  "sandbox.artifact_refused": {
    fields:
      "`sandboxId`, `userId`, `reason` (capability_missing, run_not_active, not_allowed, input_mismatch, artifact_not_found), `tool`, `runId`, `toolCallId`",
    when: "The server refused an `artifact.put`; never records content (system; at most one per 5 minutes per reason and user)",
  },
  "sandbox.export_downloaded": {
    fields: "`userId`, `files`, `bytes`",
    when: "A team admin downloaded the zip export of a departed member's workspace (counts only, KOBE-28)",
  },
  "sandbox.file_share_refused": {
    fields:
      "`sandboxId`, `userId`, `reason` (capability_missing, run_not_active, not_allowed, input_mismatch, path_mismatch, not_synced, not_found, too_large, quota_exceeded, scan_rejected), `runId`, `toolCallId`",
    when: "The server refused a `file.share` (KOBE-150); never records names, paths or content (system; at most one per 5 minutes per reason and user)",
  },
  "sandbox.lease_violation": {
    fields:
      "`sandboxId`, `userId`, `violation` (unknown_run, unknown_thread, unknown_command), `frameType`",
    when: "A sandbox named something not leased to it; connection closed (system; at most one per 5 minutes)",
  },
  "sandbox.limit_exceeded": {
    fields:
      "`sandboxId`, `userId`, `limit` (frame_rate, byte_rate, frame_size, run_events, run_bytes, thread_entries, workspace_bytes, workspace_files, workspace_file_size), `runId?`",
    when: "A sandbox exceeded a wire, storage or workspace-sync limit (KOBE-27: push refused for size, count or quota); connection closed, run failed or push refused (system; throttled)",
  },
  "sandbox.memory_refused": {
    fields:
      "`sandboxId`, `userId`, `op` (put, read), `reason` (capability_missing, run_not_active, not_allowed, input_mismatch, memory_disabled, no_project, not_a_member, approval_denied), `scope?`, `runId?`, `toolCallId?`",
    when: "The server refused a `memory.put` / `memory.read` (KOBE-156); never records paths or content (system; at most one per 5 minutes per reason and user)",
  },
  "sandbox.offboarded": {
    fields:
      "`userId`, `sandboxId?`, `trigger` (member_removed, deactivated, team_removed, reconciled), `volumeKept`, `retainUntil`",
    when: "A departed member's sandbox in the team was destroyed at once; the volume is kept 30 days for an admin export (D12, KOBE-28; the admin who acted, else system)",
  },
  "sandbox.project_file_refused": {
    fields:
      "`sandboxId`, `userId`, `reason` (capability_missing, run_not_active, not_allowed, input_mismatch, no_project, not_a_member, path_mismatch, not_synced, not_found, too_large, quota_exceeded, already_exists, approval_denied), `runId?`, `toolCallId?`",
    when: "The server refused a `project.file_propose` (KOBE-162); never records names, paths or content (system; at most one per 5 minutes per reason and user)",
  },
  "sandbox.runtime_tampered": {
    fields:
      "`sandboxId`, `userId`, `threadId`, `runId`, `runKind` (message, compaction, branch_summary), `replicaId` (server replica holding the connection)",
    when: "Pi's private runtime was changed by another process; the agent stopped Pi and the run failed `runtime_tampered` (KOBE-271). Written with the run's failure, once per run; never the agent's reason (system; no IP or user agent)",
  },
  "sandbox.skill_draft_refused": {
    fields:
      "`sandboxId`, `userId`, `reason` (capability_missing, run_not_active, not_allowed, input_mismatch, path_mismatch, not_synced, not_found, invalid_skill, too_large, draft_limit, rate_limited, replayed), `runId?`, `toolCallId?`",
    when: "The server refused a `skill.draft_save` (KOBE-442); never records names, paths or content (system; at most one per 5 minutes per reason and user)",
  },
  "sandbox.token_rejected": {
    fields: "`sandboxId`, `userId`, `reason` (not_live, not_allowed, sandbox_mismatch)",
    when: "A validly signed sandbox-wire token was refused (system; throttled)",
  },
  "sandbox.volume_deleted": {
    fields: "`userId`, `volumeDeleted`, `files`, `blobs`, `bytes`",
    when: "The sweep deleted a departed member's volume and workspace copy 30 days after departure; never while a legal hold covers them (system; counts only, KOBE-28)",
  },
  "sandbox.web_search_queried": {
    fields: "`sandboxId`, `userId`, `runId`, `toolCallId`, `provider`",
    when: "A `web_search` reached the provider (KOBE-114); counts toward the per-run cap (50); never records the query (system). Retired by KOBE-606 (built-in web search removed): no longer written; older rows stay",
  },
  "sandbox.web_search_refused": {
    fields:
      "`sandboxId`, `userId`, `reason` (capability_missing, run_not_active, not_allowed, input_mismatch, replayed), `runId`, `toolCallId`",
    when: "The server refused a `web_search.query` (KOBE-114); never records the query (system; at most one per 5 minutes per reason and user). Retired by KOBE-606 (built-in web search removed): no longer written; older rows stay",
  },
  "workspace.file_deleted": {
    fields: "`userId`, `files`, `bytes`",
    when: "The user deleted a file or folder of their own workspace in the file browser; tombstoned in the manifest, refused under a legal hold (KOBE-148; counts only)",
  },
  "workspace.file_downloaded": {
    fields: "`userId`, `bytes`",
    when: "The user downloaded a file of their own workspace in the file browser (KOBE-148; never the file name)",
  },
  "workspace.file_moved": {
    fields: "`userId`, `files`, `bytes`",
    when: "The user moved or renamed a file or folder of their own workspace in the file browser (one manifest transaction; under a legal hold it answers as usual and the old paths are kept aside; KOBE-304; counts only)",
  },
  "workspace.file_saved": {
    fields: "`userId`, `bytes`",
    when: "The user saved an edited file of their own workspace from the file editor (KOBE-462; never the file name or content)",
  },
  "workspace.file_shared": {
    fields: "`userId`, `sharedId`, `bytes`",
    when: "A workspace file was copied to a durable shared object (`share_file`, KOBE-54) (KOBE-27)",
  },
  "workspace.file_uploaded": {
    fields: "`userId`, `bytes`, optional `area` (`drop`, `artifact`), `artifactId`, `version`",
    when: "The user uploaded a file into their own workspace in the file browser (KOBE-148), dropped one on the rail (`area: drop`, KOBE-199) or copied an artifact version with Edit as file (`area: artifact` with its ids, KOBE-485); never the file name or content",
  },
  "workspace.integrity_failed": {
    fields: "`sandboxId`, `userId`, `failures`",
    when: "A sandbox uploaded bytes that did not hash to their name; nothing stored (KOBE-27; system; one row per minute per sandbox, `failures` counts every mismatch since the last row)",
  },
  "workspace.purged": {
    fields: "`userId`, `blobs`, `bytes`, `tombstones`",
    when: "Unreferenced workspace blobs and old tombstones purged from S3 and the manifest (counts only) (KOBE-27; system)",
  },
  "workspace.restored": {
    fields: "`sandboxId`, `userId`, `files`, `bytes`, `durationMs`",
    when: "A sandbox restored its `/workspace` onto an empty volume from the durable S3 copy (rebuild; counts reported by the sandbox) (KOBE-27; system)",
  },
  "workspace.sync_conflict": {
    fields: "`userId`, `conflictId`, `threadId?`, `runId?`",
    when: "The sandbox's sync kept the member's version of a file and moved the agent's unsynced edit to a conflict copy; the thread and run that last wrote it, when any (KOBE-492; system, reported by the member's sandbox; ids only, never a name, hash or content)",
  },
  "workspace.upload_refused": {
    fields: "`userId`, `reason` (file_too_large, message_too_large, quota_exceeded), `bytes`",
    when: "An upload was refused; `bytes` seen so far (KOBE-143; counts only)",
  },
  "workspace.upload_scan_refused": {
    fields: "`userId`, `reason` (scan_rejected, scan_unavailable), `bytes`",
    when: "The virus scan rejected an upload, or ClamAV was unreachable while scanning is on; the object was deleted (KOBE-146; no name, content or signature)",
  },
  "workspace.upload_stored": {
    fields: "`userId`, `fileId`, `threadId?`, `bytes`",
    when: "A file was uploaded and stored (KOBE-143; no name or content)",
  },
  "workspace.uploads_expired": {
    fields: "`files`, `bytes`",
    when: "Uploads not attached to a thread within the orphan window were deleted (KOBE-143; system; counts only)",
  },
} satisfies Record<keyof typeof SANDBOX_WIRE_EVENTS, AuditEventDoc>;
