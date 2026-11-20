import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyPendingMigrations } from "./migration-runner.js";
import { quoteIdent } from "./roles.js";
import { appColumnPrivilegesFor, appPrivilegesFor } from "./tenancy.js";

/** Migrations ship next to dist/ and src/ alike (`packages/db/drizzle`). */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface MigrateOptions {
  /** Connection as the schema owner role. Never the app role. */
  readonly databaseUrl: string;
  /** Login role the app uses; must not be superuser, BYPASSRLS, or own any table. */
  readonly appRole: string;
  readonly migrationsFolder?: string;
  /**
   * Called with every `RAISE NOTICE` a migration emits (upgrade notes, e.g. a dropped setting);
   * the migration Job logs them.
   */
  readonly onNotice?: (message: string) => void;
  /**
   * Aborting (the Job's SIGTERM at its deadline) cancels the runner's statement in Postgres, ends
   * its backend if the cancel is not enough, and so frees the migration lock; the run then rejects
   * with {@link MigrationCancelledError} (KOBE-734).
   */
  readonly signal?: AbortSignal;
}

/** The run was stopped through `signal`; nothing is left running in Postgres. */
export class MigrationCancelledError extends Error {
  constructor(cause: unknown) {
    super("migration cancelled (SIGTERM): the running statement was cancelled in Postgres", {
      cause,
    });
    this.name = "MigrationCancelledError";
  }
}

/** After the cancel request, how long the runner may take to stop before its backend is ended. */
const CANCEL_GRACE_MS = 5_000;

/** Serializes concurrent migration Jobs (e.g. overlapping Helm upgrades) and backups/restores. */
export const MIGRATION_LOCK_KEY = 0x6b6f6265; // "kobe"

interface RoleCheck {
  current_user: string;
  current_super: boolean;
  current_bypass: boolean;
  app_exists: boolean;
  app_super: boolean | null;
  app_bypass: boolean | null;
  app_owned: number;
  app_memberships: string[];
}

/** Checks both roles before any migration runs; FORCE RLS does not bind superusers or BYPASSRLS. */
async function verifyRoles(client: pg.ClientBase, appRole: string): Promise<void> {
  const { rows } = await client.query<RoleCheck>(
    `SELECT current_user,
            cur.rolsuper AS current_super, cur.rolbypassrls AS current_bypass,
            app.oid IS NOT NULL AS app_exists, app.rolsuper AS app_super, app.rolbypassrls AS app_bypass,
            (SELECT count(*)::int FROM pg_class c WHERE c.relowner = app.oid) AS app_owned,
            ARRAY(SELECT g.rolname::text FROM pg_roles g
                  WHERE app.oid IS NOT NULL AND g.oid <> app.oid AND pg_has_role(app.oid, g.oid, 'MEMBER')
                  ORDER BY 1) AS app_memberships
     FROM pg_roles cur LEFT JOIN pg_roles app ON app.rolname = $1
     WHERE cur.rolname = current_user`,
    [appRole],
  );
  const r = rows[0];
  if (!r) throw new Error("Refusing to migrate: could not read role information");
  const problems = [
    r.current_user === appRole ? "migrations must run as the owner role, not the app role" : null,
    r.current_super ? `migration role "${r.current_user}" is a superuser` : null,
    r.current_bypass ? `migration role "${r.current_user}" has BYPASSRLS` : null,
    r.app_exists ? null : `app role "${appRole}" does not exist`,
    r.app_super ? "app role is a superuser (bypasses RLS)" : null,
    r.app_bypass ? "app role has BYPASSRLS" : null,
    r.app_owned > 0 ? `app role owns ${r.app_owned} relations (owners can bypass RLS)` : null,
    r.app_memberships.length > 0
      ? `app role is a member of: ${r.app_memberships.join(", ")}`
      : null,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) throw new Error(`Refusing to migrate: ${problems.join("; ")}`);
}

/** Removes PUBLIC's ability to create objects, so the app role can't add views or functions. */
async function lockDownSchema(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ db: string }>(`SELECT current_database() AS db`);
  const db = rows[0]?.db ?? "";
  await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await client.query(
    `REVOKE CREATE, TEMPORARY ON DATABASE "${db.replaceAll('"', '""')}" FROM PUBLIC`,
  );
}

/**
 * Optional pgvector columns (KOBE-409, 0230): a superuser may enable the extension after the
 * migration that wanted it, so every run retries. Skipped on a database migrated only to an older
 * release (no function yet). Its notices (why vectors stay off) reach `onNotice`.
 */
async function ensureMemoryVectors(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ fn: string | null }>(
    `SELECT to_regprocedure('public.kobe_ensure_memory_vectors()')::text AS fn`,
  );
  if (rows[0]?.fn) await client.query(`SELECT public.kobe_ensure_memory_vectors()`);
}

/** Resets the app role to exactly the grants matrix (tenancy.ts), in one transaction. */
async function grantAppPrivileges(client: pg.ClientBase, appRole: string): Promise<void> {
  const role = quoteIdent(appRole);
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
  );
  await client.query("BEGIN");
  try {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    // Marker read by waiting pods (as the app role): which migration these grants belong to.
    // Written in this transaction, so pods never see new migrations before their grants.
    await client.query(
      `CREATE TABLE IF NOT EXISTS drizzle.kobe_grants_applied (migration_when bigint NOT NULL)`,
    );
    await client.query(`DELETE FROM drizzle.kobe_grants_applied`);
    await client.query(
      `INSERT INTO drizzle.kobe_grants_applied SELECT max(created_at) FROM drizzle.__drizzle_migrations`,
    );
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA drizzle TO ${role}`);
    await client.query(`GRANT SELECT ON drizzle.kobe_grants_applied TO ${role}`);
    for (const { name } of rows) {
      const privileges = appPrivilegesFor(name);
      if (privileges && privileges.length > 0) {
        await client.query(`GRANT ${privileges.join(", ")} ON ${quoteIdent(name)} TO ${role}`);
      }
      // REVOKE ALL above also removed earlier column privileges. Only columns the schema has:
      // the catalog check pins the exact column privileges.
      for (const [privilege, columns] of Object.entries(appColumnPrivilegesFor(name) ?? {})) {
        const { rows: present } = await client.query<{ name: string }>(
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
          [name, columns ?? []],
        );
        if (present.length === 0) continue;
        const list = present.map((c) => quoteIdent(c.name)).join(", ");
        await client.query(`GRANT ${privilege} (${list}) ON ${quoteIdent(name)} TO ${role}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Verifies roles, applies pending migrations as the owner (each committed with its bookkeeping
 * row; `-- kobe:no-transaction` files outside a transaction, migration-runner.ts), locks down
 * object creation, then resets the app role's privileges to the grants matrix. Holds an advisory
 * lock throughout.
 */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  quoteIdent(options.appRole);
  options.signal?.throwIfAborted();
  // lock_timeout: a migration queued behind a long transaction would otherwise block live
  // traffic queued behind it; failing the Job is better. Migrations must be backward compatible
  // (expand/contract), since the previous release keeps serving during the upgrade hook.
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    application_name: MIGRATE_APPLICATION_NAME,
    options: "-c lock_timeout=10s",
  });
  const { onNotice } = options;
  pool.on("connect", (client) => {
    // A backend ended on cancellation reports a FATAL outside any query: never crash on it.
    client.on("error", () => undefined);
    if (onNotice) client.on("notice", (notice) => onNotice(notice.message ?? ""));
  });
  pool.on("error", () => undefined);
  let broken = false;
  try {
    const client = await pool.connect();
    const stopCancelling = cancelOnAbort(options, client);
    try {
      await acquireMigrationLock(client, onNotice);
      try {
        await verifyRoles(client, options.appRole);
        // One transaction per migration, on this connection (it holds the lock): KOBE-734.
        await applyPendingMigrations(client, options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER);
        await ensureMemoryVectors(client);
        await lockDownSchema(client);
        await grantAppPrivileges(client, options.appRole);
      } finally {
        await client
          .query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY])
          .catch(() => undefined);
      }
    } catch (err) {
      broken = true;
      if (options.signal?.aborted) throw new MigrationCancelledError(err);
      throw err;
    } finally {
      stopCancelling();
      client.release(broken);
    }
  } finally {
    await pool.end();
  }
}

/** `application_name` of the runner's sessions: how a lock holder is recognised. */
export const MIGRATE_APPLICATION_NAME = "kobe-migrate";

/**
 * On abort: `pg_cancel_backend` the runner's backend from a second connection (a closed socket
 * alone does not stop a CREATE INDEX CONCURRENTLY), then `pg_terminate_backend` it if the run has
 * not stopped within {@link CANCEL_GRACE_MS}, which also frees its session-level advisory lock.
 */
function cancelOnAbort(options: MigrateOptions, client: pg.PoolClient): () => void {
  const signal = options.signal;
  if (!signal) return () => undefined;
  const pid = (client as unknown as { processID?: number }).processID;
  let timer: NodeJS.Timeout | undefined;
  const signalBackend = async (fn: "pg_cancel_backend" | "pg_terminate_backend") => {
    if (pid === undefined) return;
    const other = new pg.Client({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: 5_000,
      application_name: MIGRATE_APPLICATION_NAME,
    });
    other.on("error", () => undefined);
    try {
      await other.connect();
      await other.query(`SELECT ${fn}($1)`, [pid]);
    } catch {
      // Best effort: the Job is being stopped anyway.
    } finally {
      await other.end().catch(() => undefined);
    }
  };
  const onAbort = () => {
    void signalBackend("pg_cancel_backend");
    timer = setTimeout(() => void signalBackend("pg_terminate_backend"), CANCEL_GRACE_MS);
    timer.unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
  };
}

interface LockHolder {
  pid: number;
  application_name: string | null;
  state: string | null;
  query_start: Date | null;
  backend_start: Date | null;
  mode: string;
}

/** Who holds the migration lock (a migration, `kobe backup`/`restore`, or a stuck backend). */
async function lockHolders(client: pg.ClientBase): Promise<string> {
  const { rows } = await client.query<LockHolder>(
    `SELECT a.pid, a.application_name, a.state, a.query_start, a.backend_start, l.mode
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.database = (
              SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid = 0 AND l.objid = $1::bigint::oid AND l.objsubid = 1
        AND l.pid <> pg_backend_pid()`,
    [MIGRATION_LOCK_KEY],
  );
  if (rows.length === 0) return "no session found (it may just have ended)";
  return rows
    .map(
      (r) =>
        `pid ${r.pid} (application_name ${JSON.stringify(r.application_name ?? "")}, ` +
        `state ${r.state ?? "unknown"}, ${r.mode}, ` +
        `query started ${r.query_start?.toISOString() ?? "unknown"}, ` +
        `connected ${r.backend_start?.toISOString() ?? "unknown"})`,
    )
    .join("; ");
}

/**
 * Takes the migration lock, waiting at most the session's lock_timeout (10 s). When another
 * session holds it, says who (as a notice right away, and in the error if the wait times out), so
 * the operator can wait for it or end it.
 */
async function acquireMigrationLock(
  client: pg.ClientBase,
  onNotice: ((message: string) => void) | undefined,
): Promise<void> {
  const tried = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [
    MIGRATION_LOCK_KEY,
  ]);
  if (tried.rows[0]?.ok) return;
  const holders = await lockHolders(client);
  onNotice?.(`kobe: the migration lock is held by ${holders}; waiting up to 10 s`);
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "55P03") throw err;
    throw new Error(
      `the migration lock is held by another session: ${holders}. A migration, backup or ` +
        "restore is running, or a stopped migration Job's backend is still working; wait for " +
        "it, or end it with SELECT pg_terminate_backend(<pid>) and run the upgrade again",
      { cause: err },
    );
  }
}
