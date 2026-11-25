import {
  SYSTEM_ACTOR,
  and,
  eq,
  isNull,
  siteBreakGlassNotifications,
  sql,
  users,
  type BreakGlassNotificationEvent,
  type BreakGlassRecipientRole,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import { recordAudit } from "../audit/record.js";
import { activeSiteAdmins } from "../break-glass/store.js";
import { reachesTeam, NOTIFY_MAX_ATTEMPTS, type Recipient } from "../break-glass/outbox.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { readMailAppName } from "../mail/app-name.js";
import { siteGrantMessage } from "./notify.js";
import { getSiteGrant, type SiteGrantDetail, type SiteGrantRow } from "./store.js";

/**
 * Durable notifications for Site-level break-glass (KOBE-648), the same rule as the Workspace
 * grant's outbox (`../break-glass/outbox.ts`, D10), with the person's Workspaces standing in for the
 * grant's team:
 * - requested → the other active site admins (they can approve), never the subject
 * - approved, and revoked/expired while active → the active Workspace admins of every Workspace
 *   the person belongs to, the active site admins, and the person unless the grant is a legal hold
 * - denied, withdrawn, or lapsed undecided → the requester
 * Rows are written in the grant's transaction and delivered at least once with backoff.
 */

export interface SiteQueuedCounts {
  readonly recipients: number;
}

async function isActiveUser(tx: KaijuTx, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deactivatedAt)));
  return row !== undefined;
}

export async function siteRecipientsFor(
  tx: KaijuTx,
  grant: SiteGrantRow,
  event: BreakGlassNotificationEvent,
  options: { actorId: string | null; wasActive: boolean },
): Promise<Recipient[]> {
  const list: Recipient[] = [];
  if (event === "requested") {
    for (const a of await activeSiteAdmins(tx, grant.adminId)) {
      list.push({ id: a.id, role: "site_admin" });
    }
  } else if (reachesTeam(event, options.wasActive)) {
    // The person first: told as the subject even when they are also an admin.
    if (!grant.legalHold && (await isActiveUser(tx, grant.subjectUserId))) {
      list.push({ id: grant.subjectUserId, role: "subject" });
    }
    for (const a of await activeSiteAdmins(tx)) {
      list.push({ id: a.id, role: a.id === grant.adminId ? "requester" : "site_admin" });
    }
  } else if (await isActiveUser(tx, grant.adminId)) {
    list.push({ id: grant.adminId, role: "requester" });
  }
  const seen = new Set<string>();
  return list.filter((r) => {
    if (seen.has(r.id) || r.id === options.actorId) return false;
    // The subject never hears of a legal hold, nor is asked to decide a request about them.
    if ((grant.legalHold || event === "requested") && r.id === grant.subjectUserId) return false;
    seen.add(r.id);
    return true;
  });
}

export async function enqueueSiteNotifications(
  tx: KaijuTx,
  grant: SiteGrantRow,
  event: BreakGlassNotificationEvent,
  options: { actorId: string | null; wasActive?: boolean },
): Promise<SiteQueuedCounts> {
  const wasActive = options.wasActive ?? false;
  const recipients = await siteRecipientsFor(tx, grant, event, {
    actorId: options.actorId,
    wasActive,
  });
  if (recipients.length > 0) {
    await tx.insert(siteBreakGlassNotifications).values(
      recipients.map((r) => ({
        grantId: grant.id,
        event,
        wasActive,
        recipientId: r.id,
        recipientRole: r.role,
      })),
    );
  }
  return { recipients: recipients.length };
}

const LEASE = "5 minutes";
const BATCH = 50;
const backoffMinutes = (attempts: number) => Math.min(2 ** attempts, 60);

type Claimed = {
  id: string;
  grant_id: string;
  event: BreakGlassNotificationEvent;
  was_active: boolean;
  recipient_id: string;
  recipient_role: BreakGlassRecipientRole;
  attempts: number;
};

async function claim(db: KaijuDb, grantId?: string): Promise<Claimed[]> {
  const result = await db.execute<Claimed>(sql`
    UPDATE ${siteBreakGlassNotifications} SET attempts = attempts + 1,
      next_attempt_at = now() + ${LEASE}::interval
    WHERE id IN (
      SELECT id FROM ${siteBreakGlassNotifications}
      WHERE status = 'pending' AND next_attempt_at <= now()
        ${grantId ? sql`AND grant_id = ${grantId}` : sql``}
      ORDER BY created_at LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED)
    RETURNING id, grant_id, event, was_active, recipient_id, recipient_role, attempts`);
  return result.rows;
}

type Outcome = { sent: true } | { sent: false; status: "skipped" | "retry"; error: string };

async function settle(db: KaijuDb, row: Claimed, outcome: Outcome): Promise<void> {
  const where = eq(siteBreakGlassNotifications.id, row.id);
  if (outcome.sent) {
    await db
      .update(siteBreakGlassNotifications)
      .set({ status: "sent", sentAt: sql`now()`, lastError: null })
      .where(where);
    return;
  }
  if (outcome.status === "skipped") {
    await db
      .update(siteBreakGlassNotifications)
      .set({ status: "skipped", lastError: outcome.error })
      .where(where);
    return;
  }
  if (row.attempts < NOTIFY_MAX_ATTEMPTS) {
    await db
      .update(siteBreakGlassNotifications)
      .set({
        lastError: outcome.error,
        nextAttemptAt: sql`now() + make_interval(mins => ${backoffMinutes(row.attempts)})`,
      })
      .where(where);
    return;
  }
  logger.error(
    { grantId: row.grant_id, notificationId: row.id, event: row.event, attempts: row.attempts },
    "site break-glass notification gave up",
  );
  await db.transaction(async (tx) => {
    await tx
      .update(siteBreakGlassNotifications)
      .set({ status: "failed", lastError: outcome.error })
      .where(where);
    await recordAudit(tx, {
      action: "governance.site_break_glass.notification_failed",
      actor: SYSTEM_ACTOR,
      target: {
        grantId: row.grant_id,
        recipientUserId: row.recipient_id,
        event: row.event,
        attempts: row.attempts,
      },
    });
  });
}

/** Sends due Site break-glass notifications (all, or one grant's) at least once. Never throws. */
export async function deliverSiteBreakGlassNotifications(
  deps: ServerDeps,
  options: { grantId?: string } = {},
): Promise<number> {
  const db = deps.database.db;
  let sent = 0;
  try {
    const rows = await claim(db, options.grantId);
    // Read once per batch, and only when something is due (KOBE-834).
    const appName = rows.length > 0 ? await readMailAppName(db) : "";
    const details = new Map<string, SiteGrantDetail | undefined>();
    for (const row of rows) {
      if (!details.has(row.grant_id)) {
        details.set(row.grant_id, await getSiteGrant(db, row.grant_id));
      }
      const detail = details.get(row.grant_id);
      const [to] = await db
        .select({ id: users.id, name: users.name, email: users.email, off: users.deactivatedAt })
        .from(users)
        .where(eq(users.id, row.recipient_id));
      if (!detail || !to || to.off !== null) {
        await settle(db, row, { sent: false, status: "skipped", error: "recipient_inactive" });
        continue;
      }
      const message = siteGrantMessage(deps, detail, row.event, to, {
        role: row.recipient_role,
        wasActive: row.was_active,
        appName,
      });
      try {
        await deps.mailer.send(message);
        await settle(db, row, { sent: true });
        sent++;
      } catch (err) {
        logger.warn(
          { err, grantId: row.grant_id, notificationId: row.id },
          "site break-glass email failed; will retry",
        );
        await settle(db, row, { sent: false, status: "retry", error: "smtp_error" });
      }
    }
  } catch (err) {
    logger.error({ err }, "site break-glass notification delivery failed");
  }
  return sent;
}
