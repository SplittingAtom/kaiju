import { PROVENANCE_API_VERSION, type KaijuSkillManifest } from "@kaiju/protocol";
import { RULE_SET, type ScanResult } from "@kaiju/skill-scanner";
import { SYSTEM_ACTOR, sql, type KaijuDb, type KaijuTx } from "@kaiju/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/record.js";
import type { BlobStore } from "../retention/blobs.js";
import { readVerified } from "./blob-read.js";
import { queueDefaultSync } from "./default-sync.js";
import { defaultTagId, defaultTargets, lockDefaultSet, majorOf } from "./default-target.js";
import { loadKaijuPackages, type KaijuPackage } from "./kaiju-packages.js";
import { scanCanonicalZip } from "./review.js";
import { compareSemver } from "./semver.js";
import { putSkillBundle, sha256Hex } from "./storage.js";

/**
 * Kaiju's own catalog skills (KOBE-317, SK4): at every server start, the package set the server
 * ships (`kaiju-packages.ts`) is published as approved catalog versions, publisher `kaiju`, so a
 * fresh install and every upgrade end with the same catalog. Like the gallery seed, it is
 * idempotent and a failure never stops the server from starting.
 *
 * - **No person.** A Kaiju version has no submitter or reviewer and its tag, Default sync and the
 *   installs that sync makes name no user (`by_kobe`); the database refuses anything else
 *   (migration 0137). Kaiju's audit events are the system's.
 * - **Bytes first.** The runtime zip (what sandboxes fetch) and the package zip are written to the
 *   object store under content-addressed keys, `<prefix>skills/catalog/<sha256>`, before the
 *   version row commits; identical bytes from two replicas land on the same key. A start re-writes
 *   an object that went missing or bad, so a fetch never meets a hole the seed could fill.
 * - **Scanned like an upload.** A package the scanner Blocks is never published (logged).
 * - **Versions only rise.** A package whose bytes the Site already holds is unchanged (another
 *   replica, a restart, a rollback to an older release). A new one must carry a semver above the
 *   skill's newest; one reusing a semver, or lower (an older release starting after a newer one
 *   published), is refused and logged: nothing is overwritten.
 * - **Default once.** A new Kaiju skill is tagged Default and an `add` Default sync is queued
 *   (On by default, Track within major in every team, with the KOBE-314 rules: opt-outs, blocks
 *   and name conflicts are skipped). Later starts never re-tag: a Site admin who removed Default
 *   keeps that choice. A new version in the Default's major queues an `add` again, which only
 *   fills teams that miss the install; a new major waits for a Site admin to move Default (SK6).
 *
 * - **Detached skills are left alone** (KOBE-495). A Site admin's first edit of a Kaiju skill
 *   detaches it: the seed then publishes nothing for it and only records the shipped version
 *   (`kobe_shipped_version`), so the console can offer Compare and Reset to Kaiju. The seed never
 *   retires or archives a skill, detached or not, when it leaves the package set.
 *
 * Replicas starting together write each version once: every write takes the exclusive Default-set
 * lock first (the tag and the sync it queues need it anyway, KOBE-314), then the skill's row.
 */

export type KaijuSeedAction =
  | "created"
  | "published"
  | "unchanged"
  | "refused"
  | "failed"
  /** A Site admin detached the skill (KOBE-495): the shipped version is only recorded. */
  | "skipped_detached"
  /**
   * A non-Kaiju catalog skill already has this name (KOBE-620: a name Kaiju added later, which an
   * upgraded Site may hold; migration 0208 keeps it): nothing is published, a warning is logged.
   */
  | "skipped_name_taken";
export type KaijuSeedRefusal = "scan_block" | "version_reused" | "version_not_newer";

export interface KaijuSeedResult {
  readonly name: string;
  readonly semver: string;
  readonly action: KaijuSeedAction;
  readonly reason?: KaijuSeedRefusal;
}

export interface KaijuSeedDeps {
  readonly db: KaijuDb;
  readonly blobs: BlobStore;
  readonly log: Pick<Logger, "info" | "warn" | "error">;
  /** The package set; defaults to the one the server ships. */
  readonly packages?: readonly KaijuPackage[];
}

/** The object key of a catalog skill's bytes: content-addressed, the same on every replica. */
export function catalogObjectKey(prefix: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("catalog keys: not a SHA-256");
  return `${prefix}skills/catalog/${sha256}`;
}

interface Stored {
  readonly runtimeKey: string;
  readonly runtimeSize: number;
  readonly packageKey: string | null;
}

/** Writes the object unless it is already there with these bytes (verified). */
export async function ensureObject(
  blobs: BlobStore,
  bytes: Uint8Array,
  hash: string,
): Promise<string> {
  const key = catalogObjectKey(blobs.prefix, hash);
  const intact = await readVerified(blobs, key, hash, bytes.length).catch(() => null);
  if (intact === null) await putSkillBundle(blobs, key, bytes);
  return key;
}

async function storeBytes(blobs: BlobStore, p: KaijuPackage): Promise<Stored> {
  const runtimeHash = sha256Hex(p.bundle.zip);
  const runtimeKey = await ensureObject(blobs, p.bundle.zip, runtimeHash);
  const packageKey = p.bundle.packageZip
    ? await ensureObject(blobs, p.bundle.packageZip, p.bundle.packageHash)
    : null;
  return { runtimeKey, runtimeSize: p.bundle.zip.length, packageKey };
}

/** The scan as a catalog version stores it (KOBE-313: `rulesVersion` names the rule set). */
export const scanDocument = (scan: ScanResult) => ({
  verdict: scan.verdict,
  rulesVersion: scan.ruleSetVersion,
  ruleSet: RULE_SET,
  findings: scan.findings.map((f) => ({ ...f })),
  scripts: [...scan.scripts],
  skipped: [...scan.skipped],
});

/**
 * A Kaiju version's provenance (docs/skill-package.md "Kaiju-published"): what Kaiju vouches for,
 * without the promotion fields (no source team, submitter or scorecard: nobody promoted it).
 */
function provenance(p: KaijuPackage, scan: ScanResult, at: Date) {
  return {
    apiVersion: PROVENANCE_API_VERSION,
    publisher: "kaiju",
    name: p.name,
    version: p.semver,
    hashes: { runtime: sha256Hex(p.bundle.zip), package: p.bundle.packageHash },
    scan: {
      scanner: {
        name: "kaiju-skill-scanner",
        version: scan.ruleSetVersion,
        rulesVersion: scan.ruleSetVersion,
      },
      verdict: scan.verdict,
      findings: scan.findings.map(({ category, rule, file, line }) => ({
        category,
        rule,
        file,
        line,
      })),
    },
    createdAt: at.toISOString(),
  };
}

interface SkillRow {
  readonly id: string;
  readonly created: boolean;
  readonly detached: boolean;
}

async function lockedSkill(tx: KaijuTx, p: KaijuPackage): Promise<SkillRow> {
  const summary = p.manifest.summary;
  const found = await tx.execute<{ id: string; detached: boolean }>(sql`
    SELECT id, detached_at IS NOT NULL AS detached FROM registry_skills
     WHERE name = ${p.name} AND publisher = 'kaiju' FOR UPDATE`);
  const row0 = found.rows[0];
  if (row0) return { id: row0.id, created: false, detached: row0.detached === true };
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO registry_skills (name, summary, publisher)
    VALUES (${p.name}, ${summary}, 'kaiju') RETURNING id`);
  const row = inserted.rows[0];
  if (!row) throw new Error("skills: Kaiju skill insert returned no row");
  return { id: row.id, created: true, detached: false };
}

/**
 * A detached skill (KOBE-495): records the shipped version it skips (when it changed), so the
 * console can say a newer Kaiju version is available. Inside the caller's transaction or alone.
 */
async function recordShipped(
  db: KaijuDb | KaijuTx,
  name: string,
  semver: string,
): Promise<boolean> {
  const { rows } = await db.execute<{ id: string }>(sql`
    UPDATE registry_skills SET kobe_shipped_version = ${semver}, updated_at = now()
     WHERE name = ${name} AND publisher = 'kaiju' AND detached_at IS NOT NULL
       AND kobe_shipped_version IS DISTINCT FROM ${semver}
    RETURNING id`);
  return rows.length > 0;
}

/** Whether a Site admin detached the skill (a cheap check before the scan; the lock re-checks). */
async function isDetached(db: KaijuDb, name: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM registry_skills
     WHERE name = ${name} AND publisher = 'kaiju' AND detached_at IS NOT NULL`);
  return rows.length > 0;
}

type Decision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: KaijuSeedRefusal }
  | { readonly kind: "publish"; readonly seq: number };

/** What to do with `p` given the skill's versions (read under the skill's row lock). */
async function decide(tx: KaijuTx, skillId: string, p: KaijuPackage): Promise<Decision> {
  const { rows } = await tx.execute<{ semver: string; package_hash: string; seq: number }>(sql`
    SELECT semver, package_hash, seq FROM registry_versions WHERE skill_id = ${skillId}`);
  if (rows.some((r) => r.package_hash === p.bundle.packageHash)) return { kind: "unchanged" };
  if (rows.some((r) => r.semver === p.semver)) return { kind: "refused", reason: "version_reused" };
  const newest = rows.reduce<string | null>(
    (best, r) => (best === null || compareSemver(r.semver, best) > 0 ? r.semver : best),
    null,
  );
  if (newest !== null && compareSemver(p.semver, newest) < 0)
    return { kind: "refused", reason: "version_not_newer" };
  return { kind: "publish", seq: rows.reduce((n, r) => Math.max(n, Number(r.seq)), 0) + 1 };
}

async function insertVersion(
  tx: KaijuTx,
  skillId: string,
  p: KaijuPackage,
  at: { seq: number; scan: ScanResult; stored: Stored; now: Date },
): Promise<string> {
  const manifest: KaijuSkillManifest = p.manifest;
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO registry_versions (skill_id, publisher, semver, seq, runtime_hash, package_hash,
      runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
      scan, verdict, state, submitted_at, approved_at)
    VALUES (${skillId}, 'kaiju', ${p.semver}, ${at.seq}, ${sha256Hex(p.bundle.zip)},
      ${p.bundle.packageHash}, ${at.stored.runtimeKey}, ${at.stored.runtimeSize},
      ${at.stored.packageKey}, ${JSON.stringify(manifest)}::jsonb,
      ${JSON.stringify(provenance(p, at.scan, at.now))}::jsonb,
      ${JSON.stringify({ publisher: "kaiju" })}::jsonb,
      ${JSON.stringify(scanDocument(at.scan))}::jsonb, ${at.scan.verdict}::scan_verdict,
      'approved', ${at.now.toISOString()}::timestamptz, ${at.now.toISOString()}::timestamptz)
    RETURNING id`);
  const row = rows[0];
  if (!row) throw new Error("skills: Kaiju version insert returned no row");
  await tx.execute(sql`
    UPDATE registry_skills SET summary = ${p.manifest.summary}, updated_at = now()
    WHERE id = ${skillId} AND summary IS DISTINCT FROM ${p.manifest.summary}`);
  return row.id;
}

/**
 * The Default tag on a new Kaiju skill, and an `add` sync: on creation, and on a later version in
 * the Default's current major while the skill is still Default (fills teams that miss it).
 */
async function applyDefault(
  tx: KaijuTx,
  skill: SkillRow,
  version: { id: string; semver: string },
): Promise<void> {
  const target = { id: version.id, semver: version.semver, major: majorOf(version.semver) };
  if (skill.created) {
    await tx.execute(sql`
      INSERT INTO registry_skill_tags (skill_id, tag_id, by_kobe)
      VALUES (${skill.id}, ${await defaultTagId(tx)}, true)`);
    await queueDefaultSync(tx, { skillId: skill.id, kind: "add", target, requestedBy: null });
    return;
  }
  const [current] = await defaultTargets(tx, skill.id);
  if (current?.major === target.major)
    await queueDefaultSync(tx, { skillId: skill.id, kind: "add", target, requestedBy: null });
}

/** The Site already holds these bytes as a version of the skill (a restart, another replica). */
async function held(db: KaijuDb, p: KaijuPackage): Promise<boolean> {
  const { rows } = await db.execute(sql`
    SELECT 1 FROM registry_versions v JOIN registry_skills s ON s.id = v.skill_id
    WHERE s.name = ${p.name} AND v.package_hash = ${p.bundle.packageHash}`);
  return rows.length > 0;
}

/** Another publisher's catalog skill holds the name (KOBE-620). */
async function nameTaken(db: KaijuDb, name: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 FROM registry_skills WHERE name = ${name} AND publisher <> 'kaiju'`);
  return res.rows.length > 0;
}

async function seedOne(deps: KaijuSeedDeps, p: KaijuPackage): Promise<KaijuSeedResult> {
  const base = { name: p.name, semver: p.semver };
  if (await nameTaken(deps.db, p.name)) {
    deps.log.warn(
      { name: p.name, semver: p.semver },
      "skills: a Kaiju skill's name is taken by another catalog skill; Kaiju's is not published here",
    );
    return { ...base, action: "skipped_name_taken" };
  }
  if (await isDetached(deps.db, p.name)) {
    await recordShipped(deps.db, p.name, p.semver);
    return { ...base, action: "skipped_detached" };
  }
  if (await held(deps.db, p)) {
    await storeBytes(deps.blobs, p);
    return { ...base, action: "unchanged" };
  }
  const scan = await scanCanonicalZip(p.bundle.packageZip ?? p.bundle.zip);
  if (scan.verdict === "block") {
    deps.log.error(
      { name: p.name, semver: p.semver, rules: scan.findings.map((f) => f.rule) },
      "skills: a Kaiju skill package scans Block; not published",
    );
    return { ...base, action: "refused", reason: "scan_block" };
  }
  // Bytes before records, so a committed version always has its objects (re-checked each start).
  const stored = await storeBytes(deps.blobs, p);
  return deps.db.transaction(async (tx) => {
    await lockDefaultSet(tx, "exclusive");
    const skill = await lockedSkill(tx, p);
    // Detached while this start scanned it: publish nothing (KOBE-495).
    if (skill.detached) {
      await recordShipped(tx, p.name, p.semver);
      return { ...base, action: "skipped_detached" as const };
    }
    const decision = await decide(tx, skill.id, p);
    if (decision.kind === "unchanged") return { ...base, action: "unchanged" as const };
    if (decision.kind === "refused") {
      deps.log.error(
        { name: p.name, semver: p.semver, reason: decision.reason },
        "skills: a Kaiju skill package was refused (raise its version to change its files)",
      );
      return { ...base, action: "refused" as const, reason: decision.reason };
    }
    const now = new Date();
    const versionId = await insertVersion(tx, skill.id, p, {
      seq: decision.seq,
      scan,
      stored,
      now,
    });
    await applyDefault(tx, skill, { id: versionId, semver: p.semver });
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: "skill.kobe.published",
      teamId: null,
      target: {
        skillId: skill.id,
        name: p.name,
        semver: p.semver,
        runtimeHash: sha256Hex(p.bundle.zip),
        created: skill.created,
      },
    });
    return { ...base, action: skill.created ? ("created" as const) : ("published" as const) };
  });
}

/** Publishes the package set; one skill's failure is logged and never stops the others. */
export async function seedKaijuSkills(deps: KaijuSeedDeps): Promise<KaijuSeedResult[]> {
  const packages = deps.packages ?? (await loadKaijuPackages());
  const results: KaijuSeedResult[] = [];
  for (const p of packages) {
    try {
      results.push(await seedOne(deps, p));
    } catch (err) {
      deps.log.error({ err, name: p.name }, "skills: a Kaiju skill could not be published");
      results.push({ name: p.name, semver: p.semver, action: "failed" });
    }
  }
  const changed = results.filter((r) => r.action === "created" || r.action === "published");
  if (changed.length > 0)
    deps.log.info(
      { skills: changed.map((r) => `${r.name}@${r.semver}`) },
      "skills: Kaiju published",
    );
  return results;
}

/** First retry after a failed seed, doubling per attempt up to the cap (review-317 S3). */
export const KAIJU_SEED_RETRY = { firstMs: 30_000, maxMs: 30 * 60_000 } as const;

export interface KaijuSeedRunner {
  /** The first attempt (the server awaits it at start, before the Default sync runs). */
  readonly first: Promise<void>;
  /** Resolves once an attempt published or kept every package (refusals are final, not retried). */
  readonly settled: Promise<void>;
  stop(): void;
}

/**
 * Seeds now and, while any package `failed` (the object store or Postgres was briefly away at
 * an upgrade), again with backoff until one attempt gets through: the former built-ins must not
 * wait for the next restart. A refused package is logged once per attempt and not retried.
 */
export function startKaijuSeed(
  deps: KaijuSeedDeps,
  options: { readonly retry?: { firstMs: number; maxMs: number } } = {},
  seed: (deps: KaijuSeedDeps) => Promise<KaijuSeedResult[]> = seedKaijuSkills,
): KaijuSeedRunner {
  const retry = options.retry ?? KAIJU_SEED_RETRY;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const attempt = async (delay: number): Promise<void> => {
    let ok = false;
    try {
      ok = (await seed(deps)).every((r) => r.action !== "failed");
    } catch (err) {
      deps.log.error({ err }, "skills: Kaiju skills could not be seeded");
    }
    if (ok) return settle();
    if (stopped) return;
    deps.log.warn({ retryInMs: delay }, "skills: Kaiju skills seed incomplete; retrying");
    timer = setTimeout(() => void attempt(Math.min(delay * 2, retry.maxMs)), delay);
    timer.unref();
  };
  return {
    first: attempt(retry.firstMs),
    settled,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
