import { readFileSync } from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";

/**
 * KOBE-734: applies pending migrations one transaction each, instead of drizzle's `migrate()`
 * (all pending migrations in one transaction, so the first one's locks were held until the last
 * committed, and CONCURRENTLY was impossible).
 *
 * Bookkeeping is drizzle's, byte for byte: `drizzle.__drizzle_migrations (id, hash, created_at)`,
 * the hash is drizzle's `readMigrationFiles` SHA-256 of the file, `created_at` the journal's
 * `when`, and a migration is pending when its `when` is newer than the newest recorded one. So
 * drizzle-kit, `db:rebase`, `kaiju-db-wait` and installs migrated by earlier releases keep working.
 */

/** Leading comment line that makes a migration run outside a transaction. */
export const NO_TRANSACTION_MARKER = "-- kobe:no-transaction";

/**
 * How long one concurrent index build or drop may wait for a lock (older transactions, KOBE-734).
 * Several such statements must fit the migration Job's deadline (`postgres.migrateJob`).
 */
export const NO_TRANSACTION_LOCK_TIMEOUT = "2min";

export interface PendingMigration {
  readonly tag: string;
  readonly statements: readonly string[];
  readonly hash: string;
  readonly folderMillis: number;
  readonly noTransaction: boolean;
}

/** Leading `--` comment lines (blank lines between them included), then everything else. */
function leadingComments(sql: string): string[] {
  const lines: string[] = [];
  for (const line of sql.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("--")) break;
    lines.push(t);
  }
  return lines;
}

/** Whether the file's leading comment lines carry {@link NO_TRANSACTION_MARKER}. */
export function isNoTransaction(sql: string): boolean {
  return leadingComments(sql).includes(NO_TRANSACTION_MARKER);
}

/** The statement without its leading comment lines. */
function body(statement: string): string {
  return statement
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const CREATE_CONCURRENTLY = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(${IDENT})\s+ON\s`,
  "i",
);
const DROP_CONCURRENTLY = new RegExp(
  String.raw`^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+(?:${IDENT}\.)?${IDENT}\s*;?$`,
  "i",
);

/** The index a `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement builds (unquoted). */
export function concurrentIndexName(statement: string): string | undefined {
  const name = CREATE_CONCURRENTLY.exec(body(statement))?.[1];
  if (name === undefined) return undefined;
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

/**
 * A no-transaction migration may only build or drop indexes concurrently, idempotently (one
 * statement per breakpoint): a rerun after a failure must be harmless. Returns the problem.
 */
export function noTransactionProblem(statement: string): string | undefined {
  const sql = body(statement);
  if (sql === "") return undefined;
  if (concurrentIndexName(sql) !== undefined) return undefined;
  if (DROP_CONCURRENTLY.test(sql)) return undefined;
  return (
    "a -- kobe:no-transaction migration may only run CREATE [UNIQUE] INDEX CONCURRENTLY " +
    `IF NOT EXISTS or DROP INDEX CONCURRENTLY IF EXISTS, one per breakpoint: ${sql.slice(0, 80)}`
  );
}

/** The journal's migrations, in order, with drizzle's hashes. */
export function readMigrations(folder: string): PendingMigration[] {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return readMigrationFiles({ migrationsFolder: folder }).map((m, i) => {
    const tag = journal.entries[i]?.tag ?? String(m.folderMillis);
    return {
      tag,
      statements: m.sql,
      hash: m.hash,
      folderMillis: m.folderMillis,
      noTransaction: isNoTransaction(m.sql[0] ?? ""),
    };
  });
}

async function newestApplied(client: pg.ClientBase): Promise<number | undefined> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);
  const { rows } = await client.query<{ created_at: string | null }>(
    `SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
  );
  const last = rows[0]?.created_at;
  return last === undefined || last === null ? undefined : Number(last);
}

const record = (client: pg.ClientBase, m: PendingMigration) =>
  client.query(
    `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
    [m.hash, m.folderMillis],
  );

async function applyInTransaction(client: pg.ClientBase, m: PendingMigration): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of m.statements) await client.query(statement);
    await record(client, m);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/** Drops an index an interrupted concurrent build left INVALID, so the rerun builds it again. */
async function dropInvalidIndex(client: pg.ClientBase, name: string): Promise<void> {
  const { rows } = await client.query<{ schema: string }>(
    `SELECT n.nspname AS schema FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = current_schema() AND NOT i.indisvalid`,
    [name],
  );
  const schema = rows[0]?.schema;
  if (schema === undefined) return;
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quote(schema)}.${quote(name)}`);
}

async function applyWithoutTransaction(client: pg.ClientBase, m: PendingMigration): Promise<void> {
  const problem = m.statements.map(noTransactionProblem).find((p) => p !== undefined);
  if (problem) throw new Error(problem);
  // Concurrent builds take no lock that blocks traffic but wait for older transactions: give
  // them longer than the runner's 10 s (not unbounded: the Job has a deadline).
  await client.query(`SET lock_timeout = '${NO_TRANSACTION_LOCK_TIMEOUT}'`);
  try {
    for (const statement of m.statements) {
      if (body(statement) === "") continue;
      const index = concurrentIndexName(statement);
      if (index !== undefined) await dropInvalidIndex(client, index);
      await client.query(statement);
    }
    // After every statement: a crash before this line reruns the (idempotent) file.
    await record(client, m);
  } finally {
    // On a dead or cancelled connection this fails too: keep the statement's own error.
    await client.query("RESET lock_timeout").catch(() => undefined);
  }
}

/**
 * Applies every pending migration on `client` (the connection holding the migration lock), each
 * committed with its bookkeeping row. A failure stops the run with the earlier ones applied; the
 * next run continues from the failed one.
 */
export async function applyPendingMigrations(client: pg.ClientBase, folder: string): Promise<void> {
  const migrations = readMigrations(folder);
  const last = await newestApplied(client);
  for (const m of migrations) {
    if (last !== undefined && m.folderMillis <= last) continue;
    try {
      await (m.noTransaction ? applyWithoutTransaction(client, m) : applyInTransaction(client, m));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${m.tag} failed: ${message}`, { cause: err });
    }
  }
}
