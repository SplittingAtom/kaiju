import {
  AuditBusyError,
  SYSTEM_ACTOR,
  and,
  desc,
  eq,
  inArray,
  or,
  siteBreakGlassGrants,
  sql,
  users,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { enqueueSiteNotifications, type SiteQueuedCounts } from "./outbox.js";
import type { RequestSiteGrantBody } from "./schemas.js";

/**
 * Site-level break-glass grants (KOBE-648, SM28; amends D10): a site admin's request, two-person
 * approval, denial, revocation and expiry of read-only access to ONE person's portable memories.
 * Same shape as the Workspace grants in `../break-glass/store.ts`: every change runs in one
 * transaction with the grant row locked and its audit event (Site log) as the last write; the
 * `site_break_glass_grants_guard` trigger re-checks the rules in Postgres. Reading is not here: see
 * `readPortableWithSiteBreakGlass()` in @kobe/db, which audits each read in the Site log and in
 * every Workspace of the person.
 */

export type SiteGrantRow = typeof siteBreakGlassGrants.$inferSelect;
export type SiteEffectiveStatus = "pending" | "active" | "denied" | "revoked" | "expired";

export type SiteGrantError =
  | "subject_not_found"
  | "subject_is_requester"
  | "grant_not_found"
  | "not_pending"
  | "not_open"
  | "request_lapsed"
  | "self_approval_forbidden"
  | "subject_cannot_approve"
  | "subject_cannot_decide"
  | "cannot_deny_own"
  | "too_many_pending";

export type SiteGrantResult =
  | { ok: true; grant: SiteGrantRow; queued: SiteQueuedCounts }
  | { ok: false; error: SiteGrantError };

/** Open (undecided) Site-level requests one site admin may have at a time. */
export const SITE_BREAK_GLASS_MAX_PENDING_PER_ADMIN = 3;

const LOCK_TIMEOUT = "5s";
const REVOKE_LOCK_TIMEOUT = "30s";
const REVOKE_ATTEMPTS = 3;
const SWEEP_BATCH = 100;

export function siteEffectiveStatus(grant: SiteGrantRow, now = new Date()): SiteEffectiveStatus {
  if (grant.status === "approved") {
    return grant.expiresAt !== null && grant.expiresAt > now ? "active" : "expired";
  }
  if (grant.status === "pending" && grant.requestExpiresAt <= now) return "expired";
  return grant.status;
}

/** The subject's id for Site audit rows, left out under legal hold (a held site admin reads the log). */
const subjectOf = (g: SiteGrantRow) => (g.legalHold ? {} : { subjectUserId: g.subjectUserId });

async function lockGrant(
  tx: KobeTx,
  id: string,
  lockTimeout = LOCK_TIMEOUT,
): Promise<SiteGrantRow | undefined> {
  await tx.execute(sql`SELECT set_config('lock_timeout', ${lockTimeout}, true)`);
  const [row] = await tx
    .select()
    .from(siteBreakGlassGrants)
    .where(eq(siteBreakGlassGrants.id, id))
    .for("update");
  return row;
}

/** A legal hold is invisible to its subject: deciding it answers like an unknown grant. */
function subjectError(
  grant: SiteGrantRow,
  by: string,
  otherwise: SiteGrantError,
): SiteGrantError | null {
  if (grant.subjectUserId !== by) return null;
  return grant.legalHold ? "grant_not_found" : otherwise;
}

/** Whether `adminId` may approve alone: no other active site admin besides the subject. */
async function mayApproveAlone(tx: KobeTx, adminId: string, subjectId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM site_roles r JOIN users u ON u.id = r.user_id
    WHERE u.deactivated_at IS NULL AND r.user_id <> ${adminId} AND r.user_id <> ${subjectId}`);
  return (rows[0]?.n ?? 0) === 0;
}

export async function requestSiteGrant(
  db: KobeDb,
  adminId: string,
  body: RequestSiteGrantBody,
): Promise<SiteGrantResult> {
  if (body.subjectUserId === adminId) return { ok: false, error: "subject_is_requester" };
  const [subject] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, body.subjectUserId));
  if (!subject) return { ok: false, error: "subject_not_found" };
  return db.transaction(async (tx): Promise<SiteGrantResult> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.site_break_glass.requests:${adminId}`}, 0))`,
    );
    const [open] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(siteBreakGlassGrants)
      .where(
        and(
          eq(siteBreakGlassGrants.adminId, adminId),
          eq(siteBreakGlassGrants.status, "pending"),
          sql`${siteBreakGlassGrants.requestExpiresAt} > now()`,
        ),
      );
    if ((open?.n ?? 0) >= SITE_BREAK_GLASS_MAX_PENDING_PER_ADMIN) {
      return { ok: false, error: "too_many_pending" };
    }
    const [row] = await tx
      .insert(siteBreakGlassGrants)
      .values({
        subjectUserId: body.subjectUserId,
        adminId,
        reason: body.reason,
        legalHold: body.legalHold,
        durationMinutes: body.durationMinutes,
      })
      .returning();
    if (!row) throw new Error("site break-glass insert returned no row");
    const queued = await enqueueSiteNotifications(tx, row, "requested", { actorId: adminId });
    await recordAudit(tx, {
      action: "governance.site_break_glass.requested",
      target: {
        grantId: row.id,
        ...subjectOf(row),
        legalHold: row.legalHold,
        durationMinutes: row.durationMinutes,
        ...queued,
      },
    });
    return { ok: true, grant: row, queued };
  });
}

export async function approveSiteGrant(
  db: KobeDb,
  approverId: string,
  grantId: string,
): Promise<SiteGrantResult> {
  return db.transaction(async (tx): Promise<SiteGrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    const subject = subjectError(current, approverId, "subject_cannot_approve");
    if (subject) return { ok: false, error: subject };
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.requestExpiresAt <= new Date()) return { ok: false, error: "request_lapsed" };
    if (
      current.adminId === approverId &&
      !(await mayApproveAlone(tx, approverId, current.subjectUserId))
    ) {
      return { ok: false, error: "self_approval_forbidden" };
    }
    const [row] = await tx
      .update(siteBreakGlassGrants)
      .set({ status: "approved", approverId })
      .where(eq(siteBreakGlassGrants.id, grantId))
      .returning();
    if (!row?.expiresAt) throw new Error("site break-glass approval returned no window");
    const queued = await enqueueSiteNotifications(tx, row, "approved", { actorId: approverId });
    await recordAudit(tx, {
      action: "governance.site_break_glass.approved",
      target: {
        grantId: row.id,
        ...subjectOf(row),
        legalHold: row.legalHold,
        expiresAt: row.expiresAt.toISOString(),
        selfApproved: row.selfApproved,
        ...queued,
      },
    });
    return { ok: true, grant: row, queued };
  });
}

export async function denySiteGrant(
  db: KobeDb,
  by: string,
  grantId: string,
): Promise<SiteGrantResult> {
  return db.transaction(async (tx): Promise<SiteGrantResult> => {
    const current = await lockGrant(tx, grantId);
    if (!current) return { ok: false, error: "grant_not_found" };
    const subject = subjectError(current, by, "subject_cannot_decide");
    if (subject) return { ok: false, error: subject };
    if (current.status !== "pending") return { ok: false, error: "not_pending" };
    if (current.adminId === by) return { ok: false, error: "cannot_deny_own" };
    const [row] = await tx
      .update(siteBreakGlassGrants)
      .set({ status: "denied", decidedBy: by })
      .where(eq(siteBreakGlassGrants.id, grantId))
      .returning();
    if (!row) throw new Error("site break-glass denial returned no row");
    const queued = await enqueueSiteNotifications(tx, row, "denied", { actorId: by });
    await recordAudit(tx, {
      action: "governance.site_break_glass.denied",
      target: { grantId: row.id, ...queued },
    });
    return { ok: true, grant: row, queued };
  });
}

/** Withdraws a pending request or revokes an active grant; outranks reads (see the Workspace grant). */
export async function revokeSiteGrant(
  db: KobeDb,
  by: string,
  grantId: string,
): Promise<SiteGrantResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await revokeOnce(db, by, grantId);
    } catch (err) {
      if (!(err instanceof AuditBusyError) || attempt >= REVOKE_ATTEMPTS) throw err;
    }
  }
}

async function revokeOnce(db: KobeDb, by: string, grantId: string): Promise<SiteGrantResult> {
  return db.transaction(async (tx): Promise<SiteGrantResult> => {
    const current = await lockGrant(tx, grantId, REVOKE_LOCK_TIMEOUT);
    if (!current) return { ok: false, error: "grant_not_found" };
    const subject = subjectError(current, by, "subject_cannot_decide");
    if (subject) return { ok: false, error: subject };
    const status = siteEffectiveStatus(current);
    if (status !== "pending" && status !== "active") return { ok: false, error: "not_open" };
    const [row] = await tx
      .update(siteBreakGlassGrants)
      .set({ status: "revoked", decidedBy: by })
      .where(eq(siteBreakGlassGrants.id, grantId))
      .returning();
    if (!row) throw new Error("site break-glass revocation returned no row");
    const wasActive = status === "active";
    const queued = await enqueueSiteNotifications(tx, row, "revoked", { actorId: by, wasActive });
    await recordAudit(tx, {
      action: "governance.site_break_glass.revoked",
      target: { grantId: row.id, wasActive, ...queued },
    });
    return { ok: true, grant: row, queued };
  });
}

async function expireOne(db: KobeDb): Promise<SiteGrantRow | null> {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select({ id: siteBreakGlassGrants.id, status: siteBreakGlassGrants.status })
      .from(siteBreakGlassGrants)
      .where(
        or(
          and(
            eq(siteBreakGlassGrants.status, "approved"),
            sql`${siteBreakGlassGrants.expiresAt} <= now()`,
          ),
          and(
            eq(siteBreakGlassGrants.status, "pending"),
            sql`${siteBreakGlassGrants.requestExpiresAt} <= now()`,
          ),
        ),
      )
      .orderBy(siteBreakGlassGrants.requestedAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const [row] = await tx
      .update(siteBreakGlassGrants)
      .set({ status: "expired" })
      .where(eq(siteBreakGlassGrants.id, due.id))
      .returning();
    if (!row) throw new Error("site break-glass expiry returned no row");
    const wasActive = due.status === "approved";
    const queued = await enqueueSiteNotifications(tx, row, "expired", { actorId: null, wasActive });
    await recordAudit(tx, {
      action: "governance.site_break_glass.expired",
      actor: SYSTEM_ACTOR,
      target: { grantId: row.id, wasActive, ...queued },
    });
    return row;
  });
}

/** Records ended Site grants and lapsed requests (access never waits for this). */
export async function expireDueSiteGrants(db: KobeDb): Promise<SiteGrantRow[]> {
  const expired: SiteGrantRow[] = [];
  for (let i = 0; i < SWEEP_BATCH; i++) {
    const row = await expireOne(db);
    if (!row) break;
    expired.push(row);
  }
  return expired;
}

type Person = { id: string; name: string; email: string };

export interface SiteGrantDetail {
  readonly grant: SiteGrantRow;
  readonly subject: Person;
  readonly requestedBy: Person;
  readonly approvedBy: Person | null;
  readonly decidedBy: Person | null;
}

async function withDetails(
  db: KobeDb | KobeTx,
  rows: readonly SiteGrantRow[],
): Promise<SiteGrantDetail[]> {
  if (rows.length === 0) return [];
  const ids = [
    ...new Set(
      rows
        .flatMap((r) => [r.adminId, r.approverId, r.decidedBy, r.subjectUserId])
        .filter((v) => v !== null),
    ),
  ];
  const people = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  const byId = new Map(people.map((p) => [p.id, p]));
  const find = (id: string | null) => (id === null ? null : (byId.get(id) ?? null));
  return rows.map((grant) => {
    const subject = byId.get(grant.subjectUserId);
    const requestedBy = byId.get(grant.adminId);
    if (!subject || !requestedBy)
      throw new Error("site break-glass grant references a missing user");
    return {
      grant,
      subject,
      requestedBy,
      approvedBy: find(grant.approverId),
      decidedBy: find(grant.decidedBy),
    };
  });
}

/** Excludes legal-hold grants about `viewerId`. */
const hiddenFrom = (viewerId: string) =>
  sql`NOT (${siteBreakGlassGrants.legalHold} AND ${siteBreakGlassGrants.subjectUserId} = ${viewerId}::uuid)`;

/** Grants with their people, newest first. A legal hold is invisible to its subject. */
export async function listSiteGrants(
  db: KobeDb,
  viewerId: string,
  limit = 200,
): Promise<SiteGrantDetail[]> {
  const rows = await db
    .select()
    .from(siteBreakGlassGrants)
    .where(hiddenFrom(viewerId))
    .orderBy(desc(siteBreakGlassGrants.requestedAt), desc(siteBreakGlassGrants.id))
    .limit(limit);
  return withDetails(db, rows);
}

/** One grant; with `viewerId`, a legal hold about the viewer is not found. */
export async function getSiteGrant(
  db: KobeDb | KobeTx,
  id: string,
  viewerId?: string,
): Promise<SiteGrantDetail | undefined> {
  const rows = await db
    .select()
    .from(siteBreakGlassGrants)
    .where(and(eq(siteBreakGlassGrants.id, id), viewerId ? hiddenFrom(viewerId) : undefined));
  return (await withDetails(db, rows))[0];
}
