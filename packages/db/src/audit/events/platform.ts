import { z } from "zod";
import { GIT_ALLOWED_HOSTS_MAX } from "../../git/types.js";
import {
  egressDomain,
  event,
  id,
  isolationState,
  label,
  rememberLimits,
  toolCallId,
  toolName,
  toolRule,
  version,
  type AuditEventDef,
} from "./fragments.js";

export const PLATFORM_EVENTS = {
  // ── site: site-wide settings ──
  "site.settings.updated": event("site", {
    /** `kobe_mcp_mode` (KOBE-623): the Kaiju MCP site switch, value `off`, `docs` or `admin`.
     * `kobe_reads_per_minute` / `kobe_writes_per_hour` (KOBE-814): the per-person Kaiju admin limits, value 1-10000.
     * `git_connections` (KOBE-757, Workspace git G3): the Site switch, value true or false.
     * `git_allowed_hosts` (KOBE-757): the host limit, value the number of patterns (0 = any host),
     * `hosts` the patterns themselves; `previous` / `previousHosts` the values before. */
    setting: z.enum([
      "require_two_factor",
      "audit_pii_retention_hours",
      "kobe_mcp_mode",
      "kobe_reads_per_minute",
      "kobe_writes_per_hour",
      "git_connections",
      "git_allowed_hosts",
    ]),
    value: z.union([z.boolean(), z.number().int().nonnegative(), label]),
    hosts: z.array(egressDomain).max(GIT_ALLOWED_HOSTS_MAX).optional(),
    /** The value before the change (KOBE-757: git settings), and for the host list its patterns. */
    previous: z.union([z.boolean(), z.number().int().nonnegative(), label]).optional(),
    previousHosts: z.array(egressDomain).max(GIT_ALLOWED_HOSTS_MAX).optional(),
  }),
  /**
   * Site branding changed (KOBE-497, theming TH12): one event per setting. `value` is the new name,
   * the theme's label (a preset id, or `custom` with its accent, corners and font), the new
   * asset's hex sha256, or `default` when the setting was cleared or reset; never the bytes.
   */
  "site.branding.updated": event("site", {
    setting: z.enum([
      "app_name",
      "show_name",
      "theme",
      "logo",
      "logo_dark",
      "favicon",
      "logo_theme_color",
    ]),
    value: z.union([z.string().regex(/^[0-9a-f]{64}$/), label]),
  }),

  // ── platform: isolation runtime, restore (actor: system) ──
  /** A server replica's isolation state changed (spec D4); boot-time "verified" is not recorded. */
  "platform.isolation.changed": event("site", {
    from: isolationState,
    to: isolationState,
    runtimeClass: z.string().max(253).optional(),
    handler: z.string().max(63).optional(),
    replica: z.string().max(253),
  }),
  /** `kobe restore` loaded a backup into this database (written by the restore transaction). */
  "platform.restore.completed": event("site", {
    backupCreatedAt: z.iso.datetime(),
    tables: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
    /** Who ran the restore (OS user or `--operator`). */
    operator: z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/),
    /** Head of the restored chain, verified inside the restore transaction (absent if empty). */
    auditHeadSeq: z.number().int().positive().optional(),
    auditHeadHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * The started target's own chain, replaced by the backup's (KOBE-422: only its start-up
     * events): its head before the restore and its row count. Explains anchors the fresh site
     * logged before the restore. Absent when the target's log was empty.
     */
    replacedAuditHeadSeq: z.number().int().positive().optional(),
    replacedAuditHeadHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    replacedAuditRows: z.number().int().positive().optional(),
  }),

  // ── policy: tool rules and switches (D29, KOBE-35); site rules site-only, others team ──
  "policy.rule.created": event("any", toolRule),
  "policy.rule.updated": event("any", toolRule),
  /** Includes a member revoking their own remember-rule (scope `user`). */
  "policy.rule.deleted": event("any", toolRule),
  /**
   * A member's remembered approval let a call run without asking (KOBE-289), at the sandbox's
   * policy check or the MCP proxy's: one row per call, naming the rule. Never the input.
   */
  "policy.rule.applied": event("team", {
    ruleId: id,
    runId: id,
    toolCallId,
    tool: toolName,
    rememberScope: z.enum(["thread", "today", "run", "day", "month", "forever"]),
    enforcementPoint: z.enum(["sandbox", "mcp_proxy"]),
  }),
  /**
   * An admin's Dangerous agent (AC1, KOBE-476) let a call run without asking, at the sandbox's
   * policy check or the MCP proxy's: one row per call and enforcement point. Never the input.
   */
  "policy.dangerous_mode.applied": event("team", {
    runId: id,
    toolCallId,
    tool: toolName,
    agentId: id.optional(),
    agentVersion: version.optional(),
    enforcementPoint: z.enum(["sandbox", "mcp_proxy"]),
  }),
  /** The site floor's or a team's limits on remembered approvals were saved (KOBE-289). */
  "policy.remember_limits.updated": event("any", rememberLimits),
  "policy.settings.updated": event("site", {
    setting: z.enum(["prompt_sandbox_writes"]),
    value: z.boolean(),
  }),

  // ── sandbox: lifecycle metadata only, never pod logs (KOBE-22, D11) ──
  /** A user's sandbox in a team was claimed (system actor, or the user whose request did it). */
  "sandbox.created": event("team", { sandboxId: id, userId: id }),
  /**
   * The server deleted a sandbox (its claim) or a pod because it was not running under the
   * verified isolation runtime, or because isolation was lost (pods only; claims and volumes kept).
   */
  "sandbox.destroyed": event("team", {
    sandboxId: id.optional(),
    userId: id.optional(),
    pod: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
      .optional(),
    reason: z.enum(["isolation_mismatch", "isolation_lost"]),
  }),
  /**
   * The server hibernated an idle sandbox (D14: agent-sandbox `Suspended`, volume kept, /tmp
   * wiped) after `idleMinutes` without activity (system actor).
   */
  "sandbox.hibernated": event("team", {
    sandboxId: id,
    userId: id,
    idleMinutes: z.number().int().min(0).max(1440),
    /** idle: the D14 policy; operator: forced by an operator tool (idle time skipped). */
    trigger: z.enum(["idle", "operator"]),
  }),
  /**
   * The server resumed a hibernated sandbox (D14: a command needed it) through the isolation gate,
   * with the current pod template (system actor, or the user whose request woke it).
   */
  "sandbox.woken": event("team", { sandboxId: id, userId: id }),
  /**
   * A hibernated sandbox's agent sent its shutdown proof that the workspace copy is complete
   * (KOBE-733; system actor): `accepted`, or refused with `reason` (`not_hibernated`: before the
   * hibernation was committed; `refused`: another sandbox or connection, an upload in flight).
   */
  "sandbox.volume_proof": event("team", {
    sandboxId: id,
    userId: id,
    accepted: z.boolean(),
    reason: z.enum(["not_hibernated", "refused"]).optional(),
  }),
  /**
   * The dormant-volume reaper deleted a sandbox hibernated for `dormantDays` or more, with its
   * workspace volume, after proving the object-store copy covered the volume (KOBE-733; system
   * actor). The next wake starts a new sandbox and restores the workspace from that copy.
   */
  "sandbox.volume_reclaimed": event("team", {
    sandboxId: id,
    userId: id,
    dormantDays: z.number().int().min(1).max(3650),
  }),
  /**
   * A member's workspace volume was lost with its node (or reported gone or failed by Kubernetes)
   * and the member, or a team admin for them (`byAdmin`), confirmed rebuilding it from the last
   * sync (KOBE-739; actor: who confirmed). Recorded when confirmed, before the old claim and volume
   * are deleted (the cleanup is retried until done); the next wake starts a new sandbox that
   * restores from object storage, where nothing was deleted. Evidence: `reason`, `node` (the node
   * that held it), `firstSeenAt` (when this server first saw that node down; null for a claim Lost
   * or a PV missing/Failed). `lastSyncedAt`: the last push the member was shown (later changes are
   * lost, even if the node returns). `legalHold`: a hold covered the member; the lost volume could
   * not be preserved as evidence.
   */
  "sandbox.volume_rebuilt": event("team", {
    sandboxId: id.optional(),
    userId: id,
    reason: z.enum([
      "claim_lost",
      "volume_missing",
      "volume_failed",
      "node_gone",
      "node_not_ready",
    ]),
    node: z.string().min(1).max(253).optional(),
    firstSeenAt: z.iso.datetime({ offset: true }).nullable(),
    lastSyncedAt: z.iso.datetime({ offset: true }).nullable(),
    legalHold: z.boolean(),
    byAdmin: z.boolean(),
  }),
  /**
   * A confirmed rebuild found, at cleanup, a claim or volume that is not the one it was confirmed
   * for (created after the confirm, or replaced under the same name while it deleted: `replaced`),
   * so it deleted nothing more and ended (KOBE-739, review g72-3; system actor).
   */
  "sandbox.volume_rebuild_refused": event("team", {
    userId: id,
    reason: z.enum(["newer_claim", "newer_volume", "replaced"]),
  }),
  /**
   * A wake found the sandbox's pod ended (evicted, killed) and deleted it so agent-sandbox starts a
   * new one; claim, Sandbox and workspace volume are kept (KOBE-636; system actor, or the user
   * whose request woke it). `cause` in plain terms, `podReason` the pod's own (`Evicted`); the
   * kubelet's message names volumes and limits and stays in the server log.
   */
  "sandbox.restarted": event("team", {
    sandboxId: id,
    userId: id,
    cause: z.enum(["out_of_space", "out_of_memory", "stopped"]),
    podReason: z
      .string()
      .max(64)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/),
  }),
  /**
   * A woken sandbox was not Ready within the wake timeout and its run failed
   * `workspace_unavailable` (KOBE-192; system actor). Site scope: `detail` is the cluster's own
   * reason (events, volume phase) and may name nodes and volumes, so team members never see it.
   */
  "sandbox.wake_stalled": event("site", {
    teamId: id,
    sandboxId: id,
    userId: id,
    cause: z.enum([
      "volume_unschedulable",
      "volume_attach",
      "scheduling",
      "image_pull",
      "pod_failed",
      "volume_quota",
      "volume_lost",
      "volume_node_down",
      "unknown",
    ]),
    detail: z
      .string()
      .max(600)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f]*$/),
  }),
} as const satisfies Record<string, AuditEventDef>;
