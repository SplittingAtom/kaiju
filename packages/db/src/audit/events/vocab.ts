/**
 * Exported vocabularies of the audit taxonomy (KOBE-701): reason and refusal tuples other
 * modules and packages import (re-exported from `audit/events.ts` and `audit/index.ts`).
 */

/**
 * Why an app call was allowed or denied (KOBE-436, spec §6, MA5). `app_no_prompt`: an ask rule
 * matched, and the browser principal is never prompted; `app_read_only`: not a read tool;
 * `validation_busy`: the argument validator had no room for the member's call (one at a time per
 * member, a bounded queue), so nothing was judged. `thread_not_found` and `connector_off`
 * (KOBE-460): a rail picker's call names the thread on screen, which the member may not read, or
 * where the app's connector is off.
 */
export const APP_CALL_REASONS = [
  "allowed",
  "app_not_available",
  "thread_not_found",
  "connector_off",
  "tool_not_in_app",
  "tool_drifted",
  "tool_not_read_only",
  "tool_not_app_visible",
  "connector_exposure",
  "invalid_arguments",
  "validation_busy",
  "site_deny_rule",
  "team_deny_rule",
  "app_no_prompt",
  "app_read_only",
  "not_connected",
  "credential_unavailable",
  "rate_limited",
  "upstream_failed",
] as const;
export type AppCallReason = (typeof APP_CALL_REASONS)[number];

export const SIGN_IN_METHODS = [
  "password",
  "totp",
  "backup_code",
  "passkey",
  "invitation",
  /** OIDC single sign-on (KOBE-625, spec sso-oidc-scim §5). */
  "sso",
] as const;

/**
 * `memory.pass.failed.reason`: @kobe/protocol `MEMORY_PASS_FAILURE_CODES` (the server's contract
 * test keeps them equal) plus `interrupted` for a pass the stale-pass sweep failed.
 */
export const MEMORY_PASS_AUDIT_FAILURE_CODES = [
  "budget_exhausted",
  "learning_model_unavailable",
  "memory_disabled",
  "schema_rejected",
  "timeout",
  "model_error",
  "cancelled",
  "interrupted",
] as const;

/** Wire and storage limits a sandbox can hit (KOBE-24). */
export const SANDBOX_LIMITS = [
  "frame_rate",
  "byte_rate",
  "frame_size",
  "run_events",
  "run_bytes",
  "thread_entries",
  // Workspace sync (KOBE-27): a push refused for size, count or quota.
  "workspace_bytes",
  "workspace_files",
  "workspace_file_size",
] as const;

/** Why the server refused an `artifact.put` (audit `sandbox.artifact_refused`). */
export const ARTIFACT_PUT_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "artifact_not_found",
] as const;

/** Why the server refused a `file.share` (audit `sandbox.file_share_refused`, KOBE-150). */
export const FILE_SHARE_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "path_mismatch",
  "not_synced",
  "not_found",
  "too_large",
  "quota_exceeded",
  "scan_rejected",
] as const;

/** Why the server refused a `skill.draft_save` (audit `sandbox.skill_draft_refused`, KOBE-442). */
export const SKILL_DRAFT_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "path_mismatch",
  "not_synced",
  "not_found",
  "invalid_skill",
  "too_large",
  "draft_limit",
  "rate_limited",
  "replayed",
] as const;

/** Why the server refused a `memory.put` / `memory.read` (audit `sandbox.memory_refused`, KOBE-156). */
export const MEMORY_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "memory_disabled",
  "no_project",
  "not_a_member",
  "approval_denied",
] as const;

/** Why the server refused a `project.file_propose` (audit `sandbox.project_file_refused`, KOBE-162; no longer emitted since WS-7, kept so old audit rows still read). */
export const PROJECT_FILE_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "no_project",
  "not_a_member",
  "path_mismatch",
  "not_synced",
  "not_found",
  "too_large",
  "quota_exceeded",
  "already_exists",
  "approval_denied",
] as const;

/** Why the server refused a `web_search.query` (audit `sandbox.web_search_refused`, KOBE-114; no longer emitted since KOBE-606, kept so old audit rows still read). */
export const WEB_SEARCH_REFUSALS = [
  "capability_missing",
  "run_not_active",
  "not_allowed",
  "input_mismatch",
  "replayed",
] as const;

/** Why an enforcement point refused an approved call (`VerifyFailure` + no approval at all). */
export const APPROVAL_REJECT_REASONS = [
  "no_approval",
  "malformed",
  "unknown_key",
  "binding_mismatch",
  "expired",
  "bad_mac",
  "not_allowed",
  "record_mismatch",
  "run_inactive",
  "not_consumable",
  // Server-side, before an approval exists (KOBE-37 review).
  "replayed_tool_call_id",
  "too_many_approvals",
  "run_event_cap",
] as const;

/** Why a signed approval did not authorise an MCP call at the proxy (KOBE-58). */
export const MCP_APPROVAL_FAILURES = [...APPROVAL_REJECT_REASONS, "unavailable"] as const;

/** Why the retention job purged a batch (KOBE-18). */
export const RETENTION_PURGE_REASONS = ["retention", "trash", "offboarding"] as const;
