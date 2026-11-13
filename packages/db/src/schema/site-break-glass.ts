import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import {
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_REASON_MAX,
  breakGlassNotificationStatus,
  breakGlassStatus,
} from "./break-glass.js";

/**
 * Site-level break-glass (v1.3 Semantic Memory SM28, KOBE-648; amends D10): a site admin's request
 * for read-only access to ONE person's portable memories (`portable_memory_items` and their
 * versions), which follow the person across Workspaces and so cannot be named by a Workspace grant
 * (`break_glass_grants.team_id` is NOT NULL). Kept in its own site-wide table, without team_id, so
 * no existing grant check (`break_glass_active_grant`, the `break_glass_read` policies,
 * `readWithBreakGlass`) changes meaning. A person's Workspace items (`user` scope) and Workspace
 * items stay under D10's Workspace grants.
 *
 * Same lifecycle as `break_glass_grants` (pending → approved → revoked/expired; denied), the same
 * two-person rule, time box (≤ 24 h) and 24 h request deadline, enforced by the
 * `site_break_glass_grants_guard` trigger (migration `*_site_break_glass_guard.sql`). The subject
 * can never request, approve, deny or revoke a grant about themselves. Access is checked by the
 * portable break-glass read in `@kobe/db`, which locks an active grant for the requesting admin in
 * the same transaction. Never deleted (no DELETE privilege): the record behind the
 * `governance.site_break_glass.*` audit events. Holds no content (ids and the requester's reason).
 */
export const siteBreakGlassGrants = pgTable(
  "site_break_glass_grants",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** The person whose portable memories the grant reads. Users are never deleted. */
    subjectUserId: uuid()
      .notNull()
      .references(() => users.id),
    /** The site admin who asked; the only person who can read with the grant. */
    adminId: uuid()
      .notNull()
      .references(() => users.id),
    /** The second site admin who approved; the requester only when self-approved. */
    approverId: uuid().references(() => users.id),
    reason: text().notNull(),
    /** Legal hold: the subject is not notified, and Workspace audit rows leave them out (D10). */
    legalHold: boolean().notNull().default(false),
    durationMinutes: integer().notNull().default(BREAK_GLASS_DEFAULT_MINUTES),
    status: breakGlassStatus().notNull().default("pending"),
    /** Single-admin site: the requester approved their own request (D10: flagged). */
    selfApproved: boolean().notNull().default(false),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** A pending request can't be approved after this (set by the guard trigger). */
    requestExpiresAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When it was approved, denied, revoked or expired. */
    decidedAt: timestamp({ withTimezone: true }),
    /** Who denied or revoked it (approvals are `approver_id`). */
    decidedBy: uuid().references(() => users.id),
    /** Access window, assigned by the guard trigger on approval: now() + duration. */
    startsAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    /** When access ended early (revocation) or the sweep recorded its expiry. */
    endedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("site_break_glass_grants_subject_idx").on(t.subjectUserId, t.requestedAt.desc()),
    index("site_break_glass_grants_status_idx").on(t.status, t.requestedAt.desc()),
    // The expiry sweep: approved grants past their window, pending requests past their deadline.
    index("site_break_glass_grants_open_idx")
      .on(t.expiresAt, t.requestExpiresAt)
      .where(sql`${t.status} IN ('pending', 'approved')`),
    check(
      "site_break_glass_grants_reason",
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND ${sql.raw(String(BREAK_GLASS_REASON_MAX))}`,
    ),
    check(
      "site_break_glass_grants_duration",
      sql`${t.durationMinutes} BETWEEN 1 AND ${sql.raw(String(BREAK_GLASS_MAX_MINUTES))}`,
    ),
    check("site_break_glass_grants_subject_not_requester", sql`${t.subjectUserId} <> ${t.adminId}`),
    check(
      "site_break_glass_grants_subject_not_approver",
      sql`${t.approverId} IS DISTINCT FROM ${t.subjectUserId}`,
    ),
    check(
      "site_break_glass_grants_two_person",
      sql`${t.approverId} IS NULL OR (${t.approverId} = ${t.adminId}) = ${t.selfApproved}`,
    ),
    check(
      "site_break_glass_grants_window",
      sql`(${t.startsAt} IS NULL) = (${t.expiresAt} IS NULL) AND (${t.startsAt} IS NULL OR (${t.expiresAt} > ${t.startsAt} AND ${t.expiresAt} <= ${t.startsAt} + interval '24 hours'))`,
    ),
    check(
      "site_break_glass_grants_approved_shape",
      sql`${t.status} <> 'approved' OR (${t.approverId} IS NOT NULL AND ${t.startsAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Durable notification outbox for Site-level break-glass, one row per recipient, written in the
 * transaction that changes the grant (same rules as `break_glass_notifications`; recipients are
 * the site admins, the Workspace admins of each Workspace the person belongs to, and the person
 * unless the grant is a legal hold). Ids only; the message is rendered at delivery.
 */
export const siteBreakGlassNotifications = pgTable(
  "site_break_glass_notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    grantId: uuid()
      .notNull()
      .references(() => siteBreakGlassGrants.id),
    event: text().notNull(),
    /** For revoked/expired: whether the grant had given access (approved) before it ended. */
    wasActive: boolean().notNull().default(false),
    recipientId: uuid()
      .notNull()
      .references(() => users.id),
    /** Why this person is told (decides what the message may show, e.g. the reason). */
    recipientRole: text().notNull(),
    status: breakGlassNotificationStatus().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Machine-readable failure code of the last attempt (never an SMTP response text). */
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("site_break_glass_notifications_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("site_break_glass_notifications_grant_idx").on(t.grantId),
    check(
      "site_break_glass_notifications_event",
      sql`${t.event} IN ('requested', 'approved', 'denied', 'revoked', 'expired')`,
    ),
    check(
      "site_break_glass_notifications_role",
      sql`${t.recipientRole} IN ('site_admin', 'team_admin', 'subject', 'requester')`,
    ),
    check("site_break_glass_notifications_last_error", sql`char_length(${t.lastError}) <= 64`),
  ],
);
