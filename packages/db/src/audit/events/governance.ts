import { z } from "zod";
import {
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_NOTIFICATION_EVENTS,
} from "../../schema/break-glass.js";
import {
  breakGlassScope,
  count,
  event,
  id,
  legalHoldRef,
  notified,
  purgeCounts,
  retentionPeriod,
  type AuditEventDef,
} from "./fragments.js";
import { RETENTION_PURGE_REASONS } from "./vocab.js";

export const GOVERNANCE_EVENTS = {
  // ── retention: periods, purges and compaction (D18, KOBE-18); counts only, never content ──
  /** A team admin changed the team's retention period. */
  "retention.policy.changed": event("team", {
    period: retentionPeriod,
    previous: retentionPeriod,
    /** Set when the change shortens the period: it applies then (7-day grace), not now. */
    effectiveAt: z.iso.datetime({ offset: true }).optional(),
  }),
  /** A team admin cancelled the team's pending shortening during its grace period. */
  "retention.policy.change_cancelled": event("team", {
    period: retentionPeriod,
    kept: retentionPeriod,
  }),
  /** A site admin changed the longest period any team may keep threads. */
  "retention.maximum.changed": event("site", {
    maximum: retentionPeriod,
    previous: retentionPeriod,
    effectiveAt: z.iso.datetime({ offset: true }).optional(),
  }),
  /** A site admin cancelled a pending lowering of the maximum. */
  "retention.maximum.change_cancelled": event("site", {
    maximum: retentionPeriod,
    kept: retentionPeriod,
  }),
  /** Team admins were emailed about an upcoming shortening (counts only, no titles). */
  "retention.shortening_notified": event("team", {
    period: retentionPeriod,
    effectiveAt: z.iso.datetime({ offset: true }),
    threads: count,
    recipients: count,
  }),
  /**
   * A batch of threads purged by the retention job (system): past the team's period, 30 days in
   * Trash, or a departed member's (offboarding, KOBE-28; `userId`). Held data is never in a batch.
   */
  "retention.purged": event("team", {
    reason: z.enum(RETENTION_PURGE_REASONS),
    threads: count,
    ...purgeCounts,
    userId: id.optional(),
  }),
  /** Ended runs' live events folded away 7 days after the run (system; entries keep the content). */
  "retention.compacted": event("team", { runs: count, events: count }),
  /**
   * Answer feedback kept for a legal hold purged once no hold covers its thread's owner or rater
   * (system; KOBE-275; count only).
   */
  "retention.feedback_history_purged": event("team", { rows: count }),
  /**
   * Moved workspace files' old paths kept for a legal hold, purged once the hold was released
   * (system; KOBE-304; count only).
   */
  "retention.workspace_hold_history_purged": event("team", { rows: count }),
  /**
   * Shared eval cases purged (system; KOBE-276): past the team's retention window (`retention`)
   * or copies kept for a released hold (`hold_released`). Counts only, never a member: a departed
   * member's cases go with the offboarding step, unaudited on their own (review S4).
   */
  "retention.eval_cases_purged": event("team", {
    reason: z.enum(["retention", "hold_released"]),
    rows: count,
  }),
  /**
   * Workbench drafts purged (system, counts only, KOBE-320): unchanged for longer than the team's
   * window (`retention`), 30 days after their author left the team (`offboarding`), or a legal
   * hold's copies once no hold covers them (`hold_released`).
   */
  "retention.skill_drafts_purged": event("team", {
    reason: z.enum(["retention", "offboarding", "hold_released"]),
    rows: count,
  }),
  /**
   * Memory purged (system; KOBE-188, D24): superseded versions and long-deleted files past the
   * team's window (`retention`), or a departed member's personal memory (`offboarding`, `userId`).
   * Counts only, never paths or content; live files and held owners' memory are never in a batch.
   */
  "retention.memory_purged": event("team", {
    reason: z.enum(["retention", "offboarding"]),
    docs: count,
    versions: count,
    blobs: count,
    userId: id.optional(),
  }),
  /**
   * Semantic memories purged in a Workspace (system, counts only; KOBE-386, SM28): archived and
   * superseded memories and earlier versions past the Workspace window, plus evidence dropped from
   * versions whose source conversation was purged (`retention`); a departed member's personal
   * memories in the Workspace 30 days after they left (`offboarding`, `userId`). Held memories are
   * never in a batch.
   */
  "retention.semantic_memory_purged": event("team", {
    reason: z.enum(["retention", "offboarding"]),
    items: count,
    versions: count,
    scrubbed: count,
    userId: id.optional(),
  }),
  /**
   * Learn from this chat records swept in a Workspace (system, counts only; KOBE-651, SM28):
   * open To review candidates expired after 14 days, pending Workspace proposals and readers'
   * project suggestions expired after 30 days, finished learning passes and their candidates
   * purged past the Workspace window (`retention`); or everything a departed member left there
   * 30 days after they left (`offboarding`, `userId`, always recorded). Held people's rows are
   * never in a batch.
   */
  "retention.memory_learning_purged": event("team", {
    reason: z.enum(["retention", "offboarding"]),
    candidatesExpired: count,
    proposalsExpired: count,
    suggestionsExpired: count,
    passes: count,
    candidates: count,
    dismissals: count,
    watermarks: count,
    proposals: count,
    suggestions: count,
    userId: id.optional(),
  }),
  /**
   * Site or portable memories purged (KOBE-386, SM28; counts only): archived and superseded
   * memories and earlier versions past the Site window (`retention`, system), or a deactivated
   * person's portable memories purged by a site admin (`offboarding`, `userId`). `kept`: refused
   * by a Workspace's legal hold over a run that used them.
   */
  "retention.site_memory_purged": event("site", {
    lane: z.enum(["site", "portable"]),
    reason: z.enum(["retention", "offboarding"]),
    items: count,
    versions: count,
    kept: count,
    userId: id.optional(),
  }),
  /** Objects of purged rows deleted from object storage (system); `kept`: still referenced. */
  "retention.blobs_deleted": event("team", { blobs: count, kept: count }),

  // ── governance: break-glass (D10, KOBE-16); team scope, so the team's audit view shows them ──
  /** A site admin asked for read access to the team (the reason stays in the grant row). */
  "governance.break_glass.requested": event("team", {
    ...breakGlassScope,
    durationMinutes: z.number().int().min(1).max(BREAK_GLASS_MAX_MINUTES),
    ...notified,
  }),
  /** A second site admin approved; `selfApproved` flags a single-admin site (D10). */
  "governance.break_glass.approved": event("team", {
    ...breakGlassScope,
    expiresAt: z.iso.datetime({ offset: true }),
    selfApproved: z.boolean(),
    ...notified,
  }),
  "governance.break_glass.denied": event("team", { grantId: id, ...notified }),
  /** Withdrawn while pending (`wasActive` false) or revoked during its window. */
  "governance.break_glass.revoked": event("team", {
    grantId: id,
    wasActive: z.boolean(),
    ...notified,
  }),
  /** The window ended (`wasActive`) or the request lapsed undecided (actor: system). */
  "governance.break_glass.expired": event("team", {
    grantId: id,
    wasActive: z.boolean(),
    ...notified,
  }),
  /** A queued notification gave up after its retries (actor: system). */
  "governance.break_glass.notification_failed": event("team", {
    grantId: id,
    recipientUserId: id,
    event: z.enum(BREAK_GLASS_NOTIFICATION_EVENTS),
    attempts: z.number().int().positive(),
  }),
  "governance.break_glass.read": event("team", {
    grantId: id,
    object: z.enum(["thread_list", "thread", "thread_entries"]),
    threadId: id.optional(),
  }),

  // ── governance: Site-level break-glass on one person's portable memories (KOBE-648, SM28;
  // amends D10). Lifecycle in the Site log; every read is also recorded in each Workspace the
  // person belongs to (their audit views). Under legal hold the person's id is left out (the
  // grant row, resolved by `grantId` in the Site console, keeps it); never the reason.
  /** A site admin asked to read one person's portable memories. */
  "governance.site_break_glass.requested": event("site", {
    grantId: id,
    subjectUserId: id.optional(),
    legalHold: z.boolean(),
    durationMinutes: z.number().int().min(1).max(BREAK_GLASS_MAX_MINUTES),
    ...notified,
  }),
  /** A second site admin approved; `selfApproved` flags a single-admin site (D10). */
  "governance.site_break_glass.approved": event("site", {
    grantId: id,
    subjectUserId: id.optional(),
    legalHold: z.boolean(),
    expiresAt: z.iso.datetime({ offset: true }),
    selfApproved: z.boolean(),
    ...notified,
  }),
  "governance.site_break_glass.denied": event("site", { grantId: id, ...notified }),
  /** Withdrawn while pending (`wasActive` false) or revoked during its window. */
  "governance.site_break_glass.revoked": event("site", {
    grantId: id,
    wasActive: z.boolean(),
    ...notified,
  }),
  /** The window ended (`wasActive`) or the request lapsed undecided (actor: system). */
  "governance.site_break_glass.expired": event("site", {
    grantId: id,
    wasActive: z.boolean(),
    ...notified,
  }),
  /** A queued notification gave up after its retries (actor: system). */
  "governance.site_break_glass.notification_failed": event("site", {
    grantId: id,
    recipientUserId: id,
    event: z.enum(BREAK_GLASS_NOTIFICATION_EVENTS),
    attempts: z.number().int().positive(),
  }),
  /**
   * A read of the person's portable memories under the grant: one row in the Site log (no team)
   * and one in each Workspace the person belongs to (`teamId` set), all in the read's transaction.
   * `workspaces` (Site row only): how many Workspace rows were written.
   */
  "governance.site_break_glass.read": event("any", {
    grantId: id,
    object: z.enum(["portable_items", "portable_item"]),
    itemId: id.optional(),
    subjectUserId: id.optional(),
    workspaces: count.optional(),
  }),

  // ── governance: legal hold (D18, KOBE-17); site scope: holds are confidential, and the team's
  // admins may be the people held. Never the held user's id or the reason (the hold row keeps them).
  /** A site admin asked for a hold on a team, or on one user in it. */
  "governance.legal_hold.requested": event("site", legalHoldRef),
  /** A second site admin approved (or a single-admin site self-approved, flagged): in force. */
  "governance.legal_hold.placed": event("site", { ...legalHoldRef, selfApproved: z.boolean() }),
  "governance.legal_hold.denied": event("site", { holdId: id }),
  "governance.legal_hold.withdrawn": event("site", { holdId: id }),
  /** A site admin asked to release an active hold; it stays in force until approved. */
  "governance.legal_hold.release_requested": event("site", { holdId: id }),
  "governance.legal_hold.release_denied": event("site", { holdId: id }),
  "governance.legal_hold.release_withdrawn": event("site", { holdId: id }),
  /** A second site admin approved the release (single-admin site: flagged): purges resume. */
  "governance.legal_hold.released": event("site", {
    ...legalHoldRef,
    selfApproved: z.boolean(),
  }),
  // ── governance: Site-wide legal hold (v1.3 SM28, KOBE-647): a hold on the Site's own memory
  // (Site items and their versions), no team or user. The hold id only, as for legal holds.
  /** A site admin asked for a Site-wide hold. */
  "governance.site_legal_hold.requested": event("site", legalHoldRef),
  /** A second site admin approved (single-admin site: flagged): Site memory deletes are refused. */
  "governance.site_legal_hold.placed": event("site", {
    ...legalHoldRef,
    selfApproved: z.boolean(),
  }),
  "governance.site_legal_hold.denied": event("site", { holdId: id }),
  "governance.site_legal_hold.withdrawn": event("site", { holdId: id }),
  "governance.site_legal_hold.release_requested": event("site", { holdId: id }),
  "governance.site_legal_hold.release_denied": event("site", { holdId: id }),
  "governance.site_legal_hold.release_withdrawn": event("site", { holdId: id }),
  /** A second site admin approved the release (single-admin site: flagged): purges may resume. */
  "governance.site_legal_hold.released": event("site", {
    ...legalHoldRef,
    selfApproved: z.boolean(),
  }),

  // ── audit: the audit log's own maintenance (KOBE-17; actor: system) ──
  /** The IP and user agent of rows past the retention period were erased (counts only). */
  "audit.pii_erased": event("site", {
    rows: count,
    olderThanHours: z.number().int().positive(),
  }),
  /**
   * An admin downloaded the log as CSV or JSONL (KOBE-19). Site admins export the whole log
   * (site scope); a team admin's export is the team view and is recorded in the team. `rows` is
   * what was sent; `complete` is false when the download broke off or failed.
   */
  "audit.exported": event("any", {
    format: z.enum(["csv", "jsonl"]),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    rows: count,
    complete: z.boolean(),
  }),
  /** Written once after the chain v2 upgrade (server): the seal over every v1 row (hex SHA-256). */
  "audit.chain.upgraded": event("site", {
    throughSeq: z.number().int().positive(),
    rows: z.number().int().positive(),
    seal: z.string().regex(/^[0-9a-f]{64}$/),
  }),
} as const satisfies Record<string, AuditEventDef>;
