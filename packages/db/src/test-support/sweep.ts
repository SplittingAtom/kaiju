import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

/**
 * Leftovers of crashed or killed test runs (KOBE-743). A run that dies skips its `drop()`, so the
 * shared dev Postgres collected hundreds of throwaway databases, and the upgrade tests' copies of
 * the migrations folder filled RAM-backed temp dirs. Each DB suite's global setup sweeps both.
 *
 * Other worktrees run DB suites against the same server at the same time, so a database is dropped
 * only when all of these hold: its name is exactly a throwaway test database's
 * (`kaiju_test_<hex8>[_<lane>]` or `kaiju_up_<hex8>[_<lane>]`), it was created more than a day ago,
 * no session is connected to it, and a plain `DROP DATABASE` (never `WITH (FORCE)`) succeeds, which
 * Postgres refuses while anyone is connected.
 *
 * The same names with the `kobe_` prefix (before the repository rename, KOBE-752) are swept by the
 * same rules: checkouts on older code still leave them.
 */

export const STALE_TEST_DATABASE_PATTERN =
  /^(?:kaiju|kobe)_(test|up)_[0-9a-f]{8}(_[a-z0-9]{1,20})?$/;
export const STALE_TEST_DATABASE_AGE_MS = 24 * 60 * 60 * 1000;
/** At most this many drops per sweep, oldest first, so a backlog never stalls one setup for long. */
export const STALE_TEST_DATABASE_LIMIT = 100;

export interface TestDatabaseCandidate {
  readonly name: string;
  /** Creation time (mtime of the database's PG_VERSION file); null when unknown. */
  readonly createdAt: Date | null;
  /** Sessions connected to it now. */
  readonly connections: number;
}

export interface StaleSelection {
  readonly now: number;
  readonly maxAgeMs?: number;
  readonly limit?: number;
}

/** The candidates that may be dropped, oldest first: pure, so the rules are tested on their own. */
export function selectStaleTestDatabases(
  candidates: readonly TestDatabaseCandidate[],
  { now, maxAgeMs = STALE_TEST_DATABASE_AGE_MS, limit = STALE_TEST_DATABASE_LIMIT }: StaleSelection,
): string[] {
  return candidates
    .filter(
      (c) =>
        STALE_TEST_DATABASE_PATTERN.test(c.name) &&
        c.connections === 0 &&
        c.createdAt !== null &&
        Number.isFinite(c.createdAt.getTime()) &&
        now - c.createdAt.getTime() > maxAgeMs,
    )
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .slice(0, Math.max(0, limit))
    .map((c) => c.name);
}

/** Every throwaway-named database on the server with its creation time and session count. */
export async function listTestDatabaseCandidates(
  admin: pg.Client,
): Promise<TestDatabaseCandidate[]> {
  const { rows } = await admin.query<{
    name: string;
    created_at: Date | null;
    connections: number;
  }>(
    `SELECT d.datname AS name,
            (pg_stat_file('base/' || d.oid || '/PG_VERSION', true)).modification AS created_at,
            (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
       FROM pg_database d
      WHERE d.datname ~ '^(kaiju|kobe)_(test|up)_'`,
  );
  return rows.map((r) => ({ name: r.name, createdAt: r.created_at, connections: r.connections }));
}

/**
 * Drops `name` unless someone is connected: plain DROP DATABASE, which Postgres refuses while a
 * session is open. Returns false when it was refused (or already gone); refuses other names.
 */
export async function dropIdleTestDatabase(admin: pg.Client, name: string): Promise<boolean> {
  if (!STALE_TEST_DATABASE_PATTERN.test(name)) {
    throw new Error(`not a throwaway test database name: ${name}`);
  }
  try {
    await admin.query(`DROP DATABASE ${name}`);
    return true;
  } catch {
    // 55006 (in use), 3D000 (dropped by a concurrent sweep): leave it for a later run.
    return false;
  }
}

/**
 * Drops stale throwaway test databases on the server `serverUrl` points at (the setups pass
 * KAIJU_TEST_DATABASE_URL). Never fails the caller: a sweep problem is logged and the run goes on.
 */
export async function sweepStaleTestDatabases(
  serverUrl: string,
  now: number = Date.now(),
): Promise<readonly string[]> {
  const admin = new pg.Client({ connectionString: serverUrl });
  try {
    await admin.connect();
    const stale = selectStaleTestDatabases(await listTestDatabaseCandidates(admin), { now });
    const dropped: string[] = [];
    for (const name of stale) {
      if (await dropIdleTestDatabase(admin, name)) dropped.push(name);
    }
    if (dropped.length > 0) {
      console.info(`dropped ${dropped.length} stale test database(s) older than a day`);
    }
    return dropped;
  } catch (err) {
    console.warn(`stale test database sweep skipped: ${(err as Error).message}`);
    return [];
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/** Temp dir prefixes the DB package's tests create (copies of the migrations folder, ~100 MB). */
export const TEST_TEMP_DIR_PREFIXES = ["kaiju-upgrade-"] as const;
export const STALE_TEMP_DIR_AGE_MS = 60 * 60 * 1000;

/**
 * Removes `<dir>/<prefix>*` directories last modified more than `maxAgeMs` ago (default: an hour;
 * a run that is still using one finishes in seconds). Returns the removed paths.
 */
export function sweepStaleTempDirs({
  dir = tmpdir(),
  prefixes = TEST_TEMP_DIR_PREFIXES,
  maxAgeMs = STALE_TEMP_DIR_AGE_MS,
  now = Date.now(),
}: {
  readonly dir?: string;
  readonly prefixes?: readonly string[];
  readonly maxAgeMs?: number;
  readonly now?: number;
} = {}): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // Removed by a concurrent sweep, or not ours to remove: skip it.
    }
  }
  return removed;
}
