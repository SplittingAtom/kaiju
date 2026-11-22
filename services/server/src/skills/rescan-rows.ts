import { storedVerdict, type ScanResult } from "@kobe/skill-scanner";
import {
  SYSTEM_ACTOR,
  and,
  asc,
  eq,
  personalSkillScans,
  personalSkills,
  personalSkillVersions,
  sql,
  teamSkillReviews,
  teamSkillVersions,
  withTeam,
  type KobeDb,
  type StoredFinding,
} from "@kobe/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { BlobStore } from "../retention/blobs.js";
import { SCAN_DID_NOT_FINISH, scanStored, type ScanCache } from "./rescan-cache.js";
import type { SuspendedVersion } from "./rescan-notify.js";
import { storedScan } from "./review.js";

/**
 * The row work of a rescan (KOBE-313): stored scans under an older rule set (or none, before
 * KOBE-313) are redone from the stored bundle, a batch at a time. The bundle is scanned outside any
 * transaction; the row is then locked (`FOR UPDATE`) and the decision made on what it holds now,
 * so a review decision that lands meanwhile is neither lost nor overwritten blindly. Rows only
 * move forward: a row already at this rule set or a newer one is left alone.
 */
export const BATCH = 50;

export interface RowContext {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** The rule set's ordinal and name. */
  readonly ruleSet: number;
  readonly ruleSetVersion: string;
  readonly cache: ScanCache;
  /**
   * How long a version's rescan under this rule set may keep not finishing before it is suspended
   * (review g79); 0: never. Counted from the rule set's run start (`runStartedAt`).
   */
  readonly incompleteSuspendAfterMs: number;
  readonly runStartedAt: Date;
}

/** Rescans of this rule set have not finished for longer than the configured period. */
const incompleteOverdue = (ctx: RowContext) =>
  ctx.incompleteSuspendAfterMs > 0 &&
  Date.now() - ctx.runStartedAt.getTime() >= ctx.incompleteSuspendAfterMs;

/** The audit's reason for a suspension whose rescan never finished. */
const RESCAN_INCOMPLETE = "rescan_incomplete";

/** What one batch did; the caller writes it to the run row and resets it. */
export interface Tally {
  scanned: number;
  changed: number;
  failed: number;
  readonly suspended: SuspendedVersion[];
}

export const emptyTally = (): Tally => ({ scanned: 0, changed: 0, failed: 0, suspended: [] });

type RuleSetColumn = typeof teamSkillReviews.ruleSet | typeof personalSkillScans.ruleSet;
/** Under an older rule set than `n`, or none. */
export const staleSql = (column: RuleSetColumn, n: number) =>
  sql`(${column} IS NULL OR ${column} < ${n})`;
const isStale = (ruleSet: number | null, n: number) => ruleSet === null || ruleSet < n;

const bundleColumns = (t: typeof teamSkillVersions | typeof personalSkillVersions) => ({
  storageKey: t.storageKey,
  packageStorageKey: t.packageStorageKey,
  contentHash: t.contentHash,
  packageHash: t.packageHash,
  sizeBytes: t.sizeBytes,
});

const afterKey = (
  t: typeof teamSkillReviews | typeof personalSkillScans,
  after: { skillId: string; version: number } | undefined,
) =>
  after
    ? sql`(${t.skillId}, ${t.version}) > (${after.skillId}::uuid, ${after.version})`
    : undefined;

const rescanned = (ctx: RowContext, scan: ScanResult) => ({
  ...storedScan(scan),
  ruleSet: ctx.ruleSet,
  scannedAt: new Date(),
});

/** One batch of personal versions' own scans (site-wide); false when none were left. */
export async function personalBatch(
  ctx: RowContext,
  tally: Tally,
  after: { skillId: string; version: number } | undefined,
): Promise<{ skillId: string; version: number } | undefined> {
  const rows = await ctx.db
    .select({
      skillId: personalSkillScans.skillId,
      version: personalSkillScans.version,
      slug: personalSkills.slug,
      ownerId: personalSkills.ownerUserId,
      ...bundleColumns(personalSkillVersions),
    })
    .from(personalSkillScans)
    .innerJoin(
      personalSkillVersions,
      and(
        eq(personalSkillVersions.skillId, personalSkillScans.skillId),
        eq(personalSkillVersions.version, personalSkillScans.version),
      ),
    )
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillScans.skillId))
    .where(
      and(staleSql(personalSkillScans.ruleSet, ctx.ruleSet), afterKey(personalSkillScans, after)),
    )
    .orderBy(asc(personalSkillScans.skillId), asc(personalSkillScans.version))
    .limit(BATCH);
  for (const row of rows) {
    const scan = await scanStored(ctx, row, ctx.cache, {
      skillId: row.skillId,
      version: row.version,
      scope: "personal",
    });
    if (scan === SCAN_DID_NOT_FINISH) {
      tally.failed += 1;
      if (incompleteOverdue(ctx)) await suspendIncompletePersonal(ctx, row, tally);
      continue;
    }
    if (!scan) {
      tally.failed += 1;
      continue;
    }
    await ctx.db.transaction(async (tx) => {
      const key = and(
        eq(personalSkillScans.skillId, row.skillId),
        eq(personalSkillScans.version, row.version),
      );
      const [cur] = await tx
        .select({
          findings: personalSkillScans.findings,
          skipped: personalSkillScans.skipped,
          ruleSet: personalSkillScans.ruleSet,
          suspendedAt: personalSkillScans.suspendedAt,
        })
        .from(personalSkillScans)
        .where(key)
        .for("update");
      if (!cur || !isStale(cur.ruleSet, ctx.ruleSet)) return;
      const before = storedVerdict(cur);
      // A Pass version ran in every team without review: Block now needs each team's approval.
      const suspend = before === "pass" && scan.verdict === "block";
      // Suspended only because its rescan never finished (it still holds a Pass): lifted now.
      const lift = !suspend && cur.suspendedAt !== null && before === "pass";
      await tx
        .update(personalSkillScans)
        .set({
          ...rescanned(ctx, scan),
          ...(suspend ? { suspendedAt: new Date(), suspensionNotifiedAt: null } : {}),
          ...(lift ? { suspendedAt: null, suspensionNotifiedAt: null } : {}),
        })
        .where(key);
      tally.scanned += 1;
      if (before !== scan.verdict) tally.changed += 1;
      if (!suspend) return;
      const at = { skillId: row.skillId, slug: row.slug, version: row.version };
      await recordAudit(tx, {
        action: "skill.rescan.suspended",
        actor: SYSTEM_ACTOR,
        target: { ...at, scope: "personal", ruleSetVersion: ctx.ruleSetVersion },
      });
      tally.suspended.push({ ...at, scope: "personal", authorId: row.ownerId });
    });
  }
  const last = rows.at(-1);
  return last ? { skillId: last.skillId, version: last.version } : undefined;
}

interface ReviewKey {
  readonly skillId: string;
  readonly version: number;
  readonly scope: "team" | "personal";
  readonly slug: string;
}

/** The bundle and author of one review row's version (team table inside `withTeam`). */
export async function versionOf(db: KobeDb, teamId: string, row: ReviewKey) {
  if (row.scope === "team") {
    const [v] = await withTeam(db, teamId, (tx) =>
      tx
        .select({ ...bundleColumns(teamSkillVersions), authorId: teamSkillVersions.uploadedBy })
        .from(teamSkillVersions)
        .where(
          and(
            eq(teamSkillVersions.teamId, teamId),
            eq(teamSkillVersions.skillId, row.skillId),
            eq(teamSkillVersions.version, row.version),
          ),
        ),
    );
    return v;
  }
  const [v] = await db
    .select({ ...bundleColumns(personalSkillVersions), authorId: personalSkills.ownerUserId })
    .from(personalSkillVersions)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
    .where(
      and(
        eq(personalSkillVersions.skillId, row.skillId),
        eq(personalSkillVersions.version, row.version),
      ),
    );
  return v;
}

/** Locks the review row and applies the rescan to what it holds now. */
async function applyToReview(
  ctx: RowContext,
  teamId: string,
  row: ReviewKey,
  scan: ScanResult,
  authorId: string,
  tally: Tally,
): Promise<void> {
  await withTeam(ctx.db, teamId, async (tx) => {
    const key = and(
      eq(teamSkillReviews.teamId, teamId),
      eq(teamSkillReviews.skillId, row.skillId),
      eq(teamSkillReviews.version, row.version),
    );
    const [cur] = await tx
      .select({
        status: teamSkillReviews.status,
        findings: teamSkillReviews.findings,
        skipped: teamSkillReviews.skipped,
        ruleSet: teamSkillReviews.ruleSet,
        suspendedAt: teamSkillReviews.suspendedAt,
      })
      .from(teamSkillReviews)
      .where(key)
      .for("update");
    if (!cur || !isStale(cur.ruleSet, ctx.ruleSet)) return;
    const before = storedVerdict(cur as { findings: StoredFinding[]; skipped: string[] });
    const suspend = cur.status === "approved" && scan.verdict === "block" && before !== "block";
    // Approved yet suspended: only a rescan that never finished does that; a finished one that
    // doesn't block lifts it.
    const lift = !suspend && cur.status === "approved" && cur.suspendedAt !== null;
    await tx
      .update(teamSkillReviews)
      .set({
        ...rescanned(ctx, scan),
        ...(lift ? { suspendedAt: null, suspensionNotifiedAt: null } : {}),
        ...(suspend
          ? {
              status: "pending" as const,
              reviewedBy: null,
              reviewedAt: null,
              suspendedAt: new Date(),
              suspensionNotifiedAt: null,
            }
          : {}),
      })
      .where(key);
    tally.scanned += 1;
    if (before !== scan.verdict) tally.changed += 1;
    if (!suspend) return;
    const at = { skillId: row.skillId, slug: row.slug, version: row.version };
    await recordAudit(tx, {
      action: "skill.rescan.suspended",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { ...at, scope: row.scope, ruleSetVersion: ctx.ruleSetVersion },
    });
    tally.suspended.push({ ...at, scope: row.scope, teamId, authorId });
  });
}

/**
 * An approved team version whose rescan under this rule set has not finished for the configured
 * period (review g79): suspended as a Block would be (omitted from runs, audited, its people
 * told), but its approval is kept, so a later finished rescan that doesn't block lifts it again
 * (or a reviewer decides it). The row stays under its old rule set: it is retried.
 */
async function suspendIncompleteReview(
  ctx: RowContext,
  teamId: string,
  row: ReviewKey,
  authorId: string,
  tally: Tally,
): Promise<void> {
  await withTeam(ctx.db, teamId, async (tx) => {
    const key = and(
      eq(teamSkillReviews.teamId, teamId),
      eq(teamSkillReviews.skillId, row.skillId),
      eq(teamSkillReviews.version, row.version),
    );
    const [cur] = await tx
      .select({
        status: teamSkillReviews.status,
        ruleSet: teamSkillReviews.ruleSet,
        suspendedAt: teamSkillReviews.suspendedAt,
      })
      .from(teamSkillReviews)
      .where(key)
      .for("update");
    if (!cur || !isStale(cur.ruleSet, ctx.ruleSet)) return;
    if (cur.status !== "approved" || cur.suspendedAt !== null) return;
    await tx
      .update(teamSkillReviews)
      .set({ suspendedAt: new Date(), suspensionNotifiedAt: null })
      .where(key);
    const at = { skillId: row.skillId, slug: row.slug, version: row.version };
    await recordAudit(tx, {
      action: "skill.rescan.suspended",
      actor: SYSTEM_ACTOR,
      teamId,
      target: {
        ...at,
        scope: row.scope,
        ruleSetVersion: ctx.ruleSetVersion,
        reason: RESCAN_INCOMPLETE,
      },
    });
    tally.suspended.push({ ...at, scope: row.scope, teamId, authorId });
  });
}

/** The personal counterpart: a Pass version's own scan is suspended (see above). */
async function suspendIncompletePersonal(
  ctx: RowContext,
  row: { skillId: string; version: number; slug: string; ownerId: string },
  tally: Tally,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const key = and(
      eq(personalSkillScans.skillId, row.skillId),
      eq(personalSkillScans.version, row.version),
    );
    const [cur] = await tx
      .select({
        findings: personalSkillScans.findings,
        skipped: personalSkillScans.skipped,
        ruleSet: personalSkillScans.ruleSet,
        suspendedAt: personalSkillScans.suspendedAt,
      })
      .from(personalSkillScans)
      .where(key)
      .for("update");
    if (!cur || !isStale(cur.ruleSet, ctx.ruleSet) || cur.suspendedAt !== null) return;
    if (storedVerdict(cur) !== "pass") return;
    await tx
      .update(personalSkillScans)
      .set({ suspendedAt: new Date(), suspensionNotifiedAt: null })
      .where(key);
    const at = { skillId: row.skillId, slug: row.slug, version: row.version };
    await recordAudit(tx, {
      action: "skill.rescan.suspended",
      actor: SYSTEM_ACTOR,
      target: {
        ...at,
        scope: "personal",
        ruleSetVersion: ctx.ruleSetVersion,
        reason: RESCAN_INCOMPLETE,
      },
    });
    tally.suspended.push({ ...at, scope: "personal", authorId: row.ownerId });
  });
}

/** One batch of a team's review rows, under its RLS; undefined when none were left. */
export async function teamBatch(
  ctx: RowContext,
  teamId: string,
  tally: Tally,
  after: { skillId: string; version: number } | undefined,
): Promise<{ skillId: string; version: number } | undefined> {
  const rows: ReviewKey[] = await withTeam(ctx.db, teamId, (tx) =>
    tx
      .select({
        skillId: teamSkillReviews.skillId,
        version: teamSkillReviews.version,
        scope: teamSkillReviews.scope,
        slug: teamSkillReviews.slug,
      })
      .from(teamSkillReviews)
      .where(
        and(
          eq(teamSkillReviews.teamId, teamId),
          eq(teamSkillReviews.unscanned, false),
          staleSql(teamSkillReviews.ruleSet, ctx.ruleSet),
          afterKey(teamSkillReviews, after),
        ),
      )
      .orderBy(asc(teamSkillReviews.skillId), asc(teamSkillReviews.version))
      .limit(BATCH),
  );
  for (const row of rows) {
    const context = { teamId, skillId: row.skillId, version: row.version, scope: row.scope };
    const version = await versionOf(ctx.db, teamId, row);
    if (!version) ctx.log.warn(context, "skills: rescan found no version row; retried later");
    const scan = version ? await scanStored(ctx, version, ctx.cache, context) : null;
    if (version && scan === SCAN_DID_NOT_FINISH) {
      tally.failed += 1;
      if (incompleteOverdue(ctx))
        await suspendIncompleteReview(ctx, teamId, row, version.authorId, tally);
      continue;
    }
    if (!version || !scan || scan === SCAN_DID_NOT_FINISH) {
      tally.failed += 1;
      continue;
    }
    await applyToReview(ctx, teamId, row, scan, version.authorId, tally);
  }
  const last = rows.at(-1);
  return last ? { skillId: last.skillId, version: last.version } : undefined;
}

/** Whether any row is still under an older rule set (a pass must not end `done` while so). */
export async function anyStale(ctx: RowContext, teamIds: readonly string[]): Promise<boolean> {
  const [personal] = await ctx.db
    .select({ one: sql<number>`1` })
    .from(personalSkillScans)
    .where(staleSql(personalSkillScans.ruleSet, ctx.ruleSet))
    .limit(1);
  if (personal) return true;
  for (const teamId of teamIds) {
    const [row] = await withTeam(ctx.db, teamId, (tx) =>
      tx
        .select({ one: sql<number>`1` })
        .from(teamSkillReviews)
        .where(
          and(
            eq(teamSkillReviews.teamId, teamId),
            eq(teamSkillReviews.unscanned, false),
            staleSql(teamSkillReviews.ruleSet, ctx.ruleSet),
          ),
        )
        .limit(1),
    );
    if (row) return true;
  }
  return false;
}
