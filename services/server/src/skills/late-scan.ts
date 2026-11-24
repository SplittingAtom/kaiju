import {
  and,
  asc,
  eq,
  isNull,
  personalSkillScans,
  personalSkills,
  personalSkillVersions,
  scanTeams,
  teamSkillReviews,
  withTeam,
  type KaijuDb,
} from "@kaiju/db";
import type { Logger } from "pino";
import type { BlobStore } from "../retention/blobs.js";
import { SCAN_DID_NOT_FINISH, ScanCache, scanStored } from "./rescan-cache.js";
import { versionOf } from "./rescan-rows.js";
import { storedScan } from "./review.js";

/**
 * Late scans (P2-35, P2-11): versions stored without a finished scan get one in the background,
 * never inside a request. That is team review rows marked `unscanned` (backfilled versions,
 * personal versions reviewed in a team before they had a scan, and uploads whose scan didn't
 * finish), and personal skills' latest versions with no scan of their own. Until then a team row
 * can't be approved (`scan_pending`) and a personal version needs each team's approval: fail
 * closed.
 *
 * One replica at a time (advisory lock, in `startup/process-jobs.ts`), a bounded batch per pass.
 * Bytes are read verified against the version's hash (a mismatch scans as Block
 * `bundle-integrity`), and the row is written only while it is still unscanned and still names
 * that hash. Each row stands alone: one that can't be read or whose scan doesn't finish again is
 * logged and backed off (in memory, per replica), so it never holds up the rows after it.
 */
export const SKILL_LATE_SCAN_LOCK = "kobe.skills.late-scan";
export const SKILL_LATE_SCAN_MS = 30_000;
/** Scans per pass (each up to the scan timeout). */
export const LATE_SCAN_BATCH = 20;
/** Rows looked at per team (and personal versions) per pass. */
const CANDIDATES = 500;
export const LATE_SCAN_BACKOFF_BASE_MS = 60_000;
export const LATE_SCAN_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** Backoff entries kept; the oldest go first (a forgotten row is only retried sooner). */
const BACKOFF_MAX_ENTRIES = 10_000;

export interface LateScanDeps {
  readonly db: KaijuDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  readonly now?: () => number;
}

type Todo =
  | {
      readonly kind: "team";
      readonly teamId: string;
      readonly skillId: string;
      readonly version: number;
      readonly scope: "team" | "personal";
      readonly slug: string;
    }
  | { readonly kind: "personal"; readonly skillId: string; readonly version: number };

export interface LateScanReport {
  readonly scanned: number;
  readonly failed: number;
}

const keyOf = (t: Todo) =>
  t.kind === "team" ? `t:${t.teamId}:${t.skillId}:${t.version}` : `p:${t.skillId}:${t.version}`;

export class LateScanner {
  readonly #deps: LateScanDeps;
  readonly #backoff = new Map<string, { attempts: number; until: number }>();

  constructor(deps: LateScanDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** One pass: up to {@link LATE_SCAN_BATCH} rows not backing off, each on its own. */
  async pass(): Promise<LateScanReport> {
    const now = this.#now();
    const due = (await this.#candidates())
      .filter((t) => (this.#backoff.get(keyOf(t))?.until ?? 0) <= now)
      .slice(0, LATE_SCAN_BATCH);
    const cache = new ScanCache();
    let scanned = 0;
    let failed = 0;
    for (const t of due) {
      let ok = false;
      try {
        ok = await this.#scanOne(t, cache);
      } catch (err) {
        this.#deps.log.warn({ err, ...t }, "skills: late scan failed; retried later");
      }
      if (ok) {
        scanned += 1;
        this.#backoff.delete(keyOf(t));
      } else {
        failed += 1;
        this.#fail(keyOf(t), now);
      }
    }
    if (scanned > 0 || failed > 0)
      this.#deps.log.info({ scanned, failed }, "skills: late scan pass finished");
    return { scanned, failed };
  }

  #fail(key: string, now: number): void {
    const attempts = (this.#backoff.get(key)?.attempts ?? 0) + 1;
    const wait = Math.min(
      LATE_SCAN_BACKOFF_BASE_MS * 2 ** (attempts - 1),
      LATE_SCAN_BACKOFF_MAX_MS,
    );
    this.#backoff.delete(key);
    this.#backoff.set(key, { attempts, until: now + wait });
    while (this.#backoff.size > BACKOFF_MAX_ENTRIES) {
      const oldest = this.#backoff.keys().next().value as string;
      this.#backoff.delete(oldest);
    }
  }

  /** Personal versions first (one scan serves every team), then each team's unscanned rows. */
  async #candidates(): Promise<Todo[]> {
    const db = this.#deps.db;
    const personal = await db
      .select({ skillId: personalSkillVersions.skillId, version: personalSkillVersions.version })
      .from(personalSkills)
      .innerJoin(
        personalSkillVersions,
        and(
          eq(personalSkillVersions.skillId, personalSkills.id),
          eq(personalSkillVersions.version, personalSkills.latestVersion),
        ),
      )
      .leftJoin(
        personalSkillScans,
        and(
          eq(personalSkillScans.skillId, personalSkillVersions.skillId),
          eq(personalSkillScans.version, personalSkillVersions.version),
        ),
      )
      .where(isNull(personalSkillScans.skillId))
      .orderBy(asc(personalSkillVersions.skillId))
      .limit(CANDIDATES);
    const perTeam = await scanTeams(db, "skill late scan", async (tx, team) => {
      const rows = await tx
        .select({
          skillId: teamSkillReviews.skillId,
          version: teamSkillReviews.version,
          scope: teamSkillReviews.scope,
          slug: teamSkillReviews.slug,
        })
        .from(teamSkillReviews)
        .where(and(eq(teamSkillReviews.teamId, team.id), eq(teamSkillReviews.unscanned, true)))
        .orderBy(
          asc(teamSkillReviews.scannedAt),
          asc(teamSkillReviews.skillId),
          asc(teamSkillReviews.version),
        )
        .limit(CANDIDATES);
      return rows.length > 0
        ? rows.map((r): Todo => ({ kind: "team", teamId: team.id, ...r }))
        : undefined;
    });
    return [...personal.map((p): Todo => ({ kind: "personal", ...p })), ...perTeam.flat()];
  }

  /** Scans one row's version and stores the result; false when it must be tried again. */
  async #scanOne(t: Todo, cache: ScanCache): Promise<boolean> {
    return t.kind === "team" ? this.#scanReview(t, cache) : this.#scanPersonal(t, cache);
  }

  async #scanReview(t: Extract<Todo, { kind: "team" }>, cache: ScanCache): Promise<boolean> {
    const { db } = this.#deps;
    const context = { teamId: t.teamId, skillId: t.skillId, version: t.version, scope: t.scope };
    const version = await versionOf(db, t.teamId, t);
    if (!version) {
      this.#deps.log.warn(context, "skills: late scan found no version row; retried later");
      return false;
    }
    // Null: bytes missing, or the scan failed or didn't finish (logged there).
    const scan = await scanStored(this.#deps, version, cache, context);
    if (!scan || scan === SCAN_DID_NOT_FINISH) return false;
    await withTeam(db, t.teamId, (tx) =>
      tx
        .update(teamSkillReviews)
        .set({
          ...storedScan(scan),
          unscanned: false,
          scannedAt: new Date(),
          rescanIncompleteSince: null,
          rescanIncompleteRuleSet: null,
        })
        .where(
          and(
            eq(teamSkillReviews.teamId, t.teamId),
            eq(teamSkillReviews.skillId, t.skillId),
            eq(teamSkillReviews.version, t.version),
            eq(teamSkillReviews.unscanned, true),
            // The verdict belongs to the bytes just verified, never to another hash.
            eq(teamSkillReviews.contentHash, version.contentHash),
          ),
        ),
    );
    return true;
  }

  async #scanPersonal(t: Extract<Todo, { kind: "personal" }>, cache: ScanCache): Promise<boolean> {
    const { db } = this.#deps;
    const context = { skillId: t.skillId, version: t.version, scope: "personal" };
    const [version] = await db
      .select({
        storageKey: personalSkillVersions.storageKey,
        packageStorageKey: personalSkillVersions.packageStorageKey,
        contentHash: personalSkillVersions.contentHash,
        packageHash: personalSkillVersions.packageHash,
        sizeBytes: personalSkillVersions.sizeBytes,
      })
      .from(personalSkillVersions)
      .where(
        and(
          eq(personalSkillVersions.skillId, t.skillId),
          eq(personalSkillVersions.version, t.version),
        ),
      );
    if (!version) return false;
    const scan = await scanStored(this.#deps, version, cache, context);
    if (!scan || scan === SCAN_DID_NOT_FINISH) return false;
    await db
      .insert(personalSkillScans)
      .values({ skillId: t.skillId, version: t.version, ...storedScan(scan) })
      .onConflictDoNothing();
    return true;
  }
}
