import type { AuditEventDoc } from "./fragments.js";
import type { PLATFORM_EVENTS } from "./platform.js";

/**
 * The docs/audit-log.md rows of the platform area's events (KOBE-815), in name order; the table is
 * generated from these (`pnpm --filter @kobe/db audit:doc`). Add an event's row here in name order.
 */
export const PLATFORM_EVENT_DOCS = {
  "platform.isolation.changed": {
    fields: "`from`, `to`, `runtimeClass?`, `handler?`, `replica`",
    when: "A server replica lost or regained isolation, or started without it (system)",
  },
  "platform.restore.completed": {
    fields:
      "`backupCreatedAt`, `tables`, `rows`, `operator`, `auditHeadSeq?`, `auditHeadHash?`, `replacedAuditHeadSeq?`, `replacedAuditHeadHash?`, `replacedAuditRows?`",
    when: "`kobe restore` loaded and verified a backup (system, same transaction)",
  },
  "policy.dangerous_mode.applied": {
    fields:
      "`runId`, `toolCallId`, `tool`, `agentId?`, `agentVersion?`, `enforcementPoint` (sandbox, mcp_proxy)",
    when: "An admin's Dangerous agent let a call run without asking (AC1, KOBE-476), one row per call and enforcement point",
  },
  "policy.remember_limits.updated": {
    fields:
      "`scope` (site, team), `scopes`, `maxDurationSeconds`, `mcpTools`, `exactOnly`, `approveAll`",
    when: "The site floor's or a team's limits on remembered approvals were saved (KOBE-289)",
  },
  "policy.rule.applied": {
    fields:
      "`ruleId`, `runId`, `toolCallId`, `tool`, `rememberScope`, `enforcementPoint` (sandbox, mcp_proxy)",
    when: "A member's remembered approval let a call run without asking (KOBE-289), one row per call",
  },
  "policy.rule.created": {
    fields:
      "`ruleId`, `scope` (install, team, user), `effect`, `toolGlob`, `argPatternEntries`, `expiresAt`, `rememberScope?`, `threadId?`, `runId?`",
    when: "Tool rule created (site floor: install; team and user rules: team)",
  },
  "policy.rule.deleted": {
    fields: "as `policy.rule.created`",
    when: "Tool rule deleted, including a member revoking their own remember-rule",
  },
  "policy.rule.updated": { fields: "as `policy.rule.created`", when: "Tool rule replaced" },
  "policy.settings.updated": {
    fields: "`setting` (prompt_sandbox_writes), `value`",
    when: "Site policy switch changed",
  },
  "sandbox.created": {
    fields: "`sandboxId`, `userId`",
    when: "A user's sandbox in a team was claimed (KOBE-22)",
  },
  "sandbox.destroyed": {
    fields: "`sandboxId?`, `userId?`, `pod?`, `reason` (isolation_mismatch, isolation_lost)",
    when: "The server deleted a sandbox or pod not running under the verified isolation runtime (KOBE-22)",
  },
  "sandbox.hibernated": {
    fields: "`sandboxId`, `userId`, `idleMinutes`, `trigger` (idle, operator)",
    when: "A sandbox was hibernated: the D14 idle policy, or forced by an operator tool (system actor) (KOBE-25)",
  },
  "sandbox.restarted": {
    fields: "`sandboxId`, `userId`, `cause` (out_of_space, out_of_memory, stopped), `podReason`",
    when: "A wake found the sandbox pod ended (e.g. evicted: `$HOME` over `sandbox.homeSize`) and deleted it so agent-sandbox starts a new one; claim, Sandbox and `/workspace` volume kept. The kubelet message is in the server log only (KOBE-636)",
  },
  "sandbox.volume_proof": {
    fields: "`sandboxId`, `userId`, `accepted`, `reason?` (not_hibernated, refused)",
    when: "A hibernated sandbox's agent sent its shutdown proof that the workspace copy is complete; accepted, or refused because the hibernation was not committed yet or the sandbox, connection or a pending upload did not match (system, KOBE-733)",
  },
  "sandbox.volume_rebuild_refused": {
    fields: "`userId`, `reason`",
    when: "A confirmed rebuild found at cleanup a claim or volume that is not the one it was confirmed for (`newer_claim`, `newer_volume`: created after the confirm; `replaced`: replaced under the same name while it deleted, a UID precondition failed) and deleted nothing more; the member is told to reload (system, KOBE-739)",
  },
  "sandbox.volume_rebuilt": {
    fields:
      "`sandboxId`?, `userId`, `reason`, `node`?, `firstSeenAt`, `lastSyncedAt`, `legalHold`, `byAdmin`",
    when: "A member's workspace volume was lost (the claim `Lost`, the PV missing or `Failed`, or its only node missing or not Ready continuously for `sandbox.volumeLoss.graceMinutes` since `firstSeenAt`, the server's first observation) and the member, or a team admin for them (`byAdmin`), confirmed rebuilding it from the last sync (`lastSyncedAt`). Recorded at the confirm, before the old claim and volume are deleted (a failed cleanup is retried); the next wake restores from object storage, where nothing was deleted. Changes after `lastSyncedAt` are lost even if `node` returns. `legalHold`: a hold covered the member; the lost volume could not be kept as evidence (actor: who confirmed, KOBE-739)",
  },
  "sandbox.volume_reclaimed": {
    fields: "`sandboxId`, `userId`, `dormantDays`",
    when: "The dormant-volume reaper deleted a sandbox hibernated for `dormantDays` or more, with its workspace volume, after the agent proved at shutdown that the object-store copy was complete and nothing changed since (no pending or lost uploads, no legal hold); the next wake restores the workspace from that copy (system, KOBE-733; off unless `sandbox.hibernation.reclaim.enabled`)",
  },
  "sandbox.wake_stalled": {
    fields: "`teamId`, `sandboxId`, `userId`, `cause`, `detail`",
    when: "A woken sandbox was not Ready (definite stall signal or the wake budget); the run failed `workspace_unavailable` (`sandbox_failed` for cause `pod_failed`, KOBE-636; `workspace_quota_exhausted` for cause `volume_quota`, the team's volume quota is full, KOBE-733; `workspace_volume_lost` for cause `volume_lost`, the workspace volume was lost, and `workspace_volume_unreachable` or `workspace_volume_lost` for cause `volume_node_down`, its only node is down, by the grace period, KOBE-739). `detail` is the cluster reason and names nodes/volumes (site admins only) (KOBE-192)",
  },
  "sandbox.woken": {
    fields: "`sandboxId`, `userId`",
    when: "A hibernated sandbox's resume was committed (isolation gate passed; recorded before its pod verifies) (KOBE-25)",
  },
  "site.branding.updated": {
    fields:
      "`setting` (app_name, show_name, theme, logo, logo_dark, favicon, logo_theme_color), `value` (the name; `true`/`false`; the theme label `theme:<preset>` or `theme:custom #rrggbb`; the file's sha256, or `removed` for a removal or reset; never the bytes)",
    when: "Site branding changed, one event per changed setting (KOBE-497, theming TH12); a reset records the default label per cleared setting. The chart-seeded defaults are recorded with the system as actor (KOBE-503)",
  },
  "site.settings.updated": {
    fields: "`setting` (require_two_factor, audit_pii_retention_hours, kobe_mcp_mode), `value`",
    when: "Site setting changed",
  },
} satisfies Record<keyof typeof PLATFORM_EVENTS, AuditEventDoc>;
