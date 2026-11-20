import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type KobeDb = NodePgDatabase<typeof schema>;
export type KobeTx = Parameters<Parameters<KobeDb["transaction"]>[0]>[0];

export interface KobeDatabase {
  readonly db: KobeDb;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Default `statement_timeout` of app-role connections (KOBE-732). Generous: no request needs
 * this long; jobs that legitimately run longer (retention purge and compaction batches) raise it
 * for their own transaction with `SET LOCAL statement_timeout` ({@link JOB_STATEMENT_TIMEOUT}).
 */
export const APP_STATEMENT_TIMEOUT_MS = 120_000;
/**
 * Default `idle_in_transaction_session_timeout` of app-role connections (KOBE-732): a transaction
 * that waits this long on something other than Postgres (an object store or Kubernetes call that
 * hangs) is ended by Postgres, releasing its locks. The calls Kobe makes inside a transaction are
 * bounded well below this (object deletes 30 s + 10 s, Kubernetes 10 s per call).
 */
export const APP_IDLE_IN_TRANSACTION_TIMEOUT_MS = 300_000;
/** `SET LOCAL statement_timeout` value for a job's batch transaction that may run long. */
export const JOB_STATEMENT_TIMEOUT = "10min";

export interface CreateDbOptions {
  /** Pool size (default 10). */
  readonly max?: number;
  /** How long to wait for a free pooled connection before failing (default 10 s). */
  readonly acquireTimeoutMs?: number;
  /** `statement_timeout` of every connection (default {@link APP_STATEMENT_TIMEOUT_MS}; 0: none). */
  readonly statementTimeoutMs?: number;
  /**
   * `idle_in_transaction_session_timeout` of every connection (default
   * {@link APP_IDLE_IN_TRANSACTION_TIMEOUT_MS}; 0: none).
   */
  readonly idleInTransactionTimeoutMs?: number;
}

/**
 * Connects as the app role. Team data is reachable only through `withTeam()`. The timeouts are
 * set with `SET` on each new connection (not as startup parameters, which PgBouncer refuses), so
 * they hold whatever the role's own defaults are; `SET LOCAL` in a transaction still overrides.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): KobeDatabase {
  const statementTimeout = timeoutMs(options.statementTimeoutMs, APP_STATEMENT_TIMEOUT_MS);
  const idleTimeout = timeoutMs(
    options.idleInTransactionTimeoutMs,
    APP_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  );
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.acquireTimeoutMs ?? 10_000,
    // Awaited by the pool before it hands the connection out (a failure fails the acquire).
    onConnect: async (client) => {
      // Postgres ends a session idle in a transaction with a FATAL error while the client is
      // checked out (no pool listener then): without a listener of its own the client's 'error'
      // event would crash the process. The transaction's next query fails instead and the pool
      // drops the client.
      client.on("error", () => undefined);
      await client.query(
        `SET statement_timeout = ${statementTimeout}; ` +
          `SET idle_in_transaction_session_timeout = ${idleTimeout}`,
      );
    },
  });
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}

/** A non-negative integer of milliseconds (0: no timeout); anything else is a programming error. */
function timeoutMs(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`invalid timeout: ${String(ms)} ms`);
  return ms;
}
