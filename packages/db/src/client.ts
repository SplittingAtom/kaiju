import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type KaijuDb = NodePgDatabase<typeof schema>;
export type KaijuTx = Parameters<Parameters<KaijuDb["transaction"]>[0]>[0];

export interface KaijuDatabase {
  readonly db: KaijuDb;
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
 * hangs) is ended by Postgres, releasing its locks. The calls Kaiju makes inside a transaction are
 * bounded well below this (object deletes 30 s + 10 s, Kubernetes 10 s per call).
 */
export const APP_IDLE_IN_TRANSACTION_TIMEOUT_MS = 300_000;
/** `SET LOCAL statement_timeout` value for a job's batch transaction that may run long. */
export const JOB_STATEMENT_TIMEOUT = "10min";

/** SQLSTATE of a session Postgres ended for idling in a transaction. */
export const IDLE_IN_TRANSACTION_SQLSTATE = "25P03";

/**
 * The connection was lost under a transaction (KOBE-732): every later query on it, the caller's
 * and drizzle's ROLLBACK alike, fails with this error, `cause` being Postgres' FATAL error.
 */
export class DatabaseConnectionLostError extends Error {
  readonly code: string | undefined;
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "DatabaseConnectionLostError";
    const code = (cause as { code?: unknown } | null)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
}

/**
 * Postgres ended the session because its transaction sat idle longer than
 * `idle_in_transaction_session_timeout` (SQLSTATE 25P03): the transaction's locks are released and
 * its work is rolled back; nothing retries it automatically.
 */
export class IdleInTransactionTimeoutError extends DatabaseConnectionLostError {
  constructor(cause: unknown) {
    super(
      "the transaction sat idle longer than idle_in_transaction_session_timeout; Postgres ended it",
      cause,
    );
    this.name = "IdleInTransactionTimeoutError";
  }
}

/** Called with an error Postgres sent on a connection outside any query (e.g. a FATAL cut). */
export type ConnectionErrorLog = (err: unknown, sqlstate: string | undefined) => void;

const defaultConnectionErrorLog: ConnectionErrorLog = (err, sqlstate) => {
  console.warn(`database connection lost${sqlstate ? ` (${sqlstate})` : ""}: ${String(err)}`);
};

export interface AppSessionOptions {
  /** `statement_timeout` of every connection (default {@link APP_STATEMENT_TIMEOUT_MS}; 0: none). */
  readonly statementTimeoutMs?: number;
  /**
   * `idle_in_transaction_session_timeout` of every connection (default
   * {@link APP_IDLE_IN_TRANSACTION_TIMEOUT_MS}; 0: none).
   */
  readonly idleInTransactionTimeoutMs?: number;
  /** Where a lost connection's error goes (default: a console warning with its SQLSTATE). */
  readonly onConnectionError?: ConnectionErrorLog;
}

export interface CreateDbOptions extends AppSessionOptions {
  /** Pool size (default {@link DEFAULT_POOL_MAX}). */
  readonly max?: number;
  /**
   * `application_name` of the pool's sessions (KOBE-736), so `pg_stat_activity` attributes each
   * connection to its service (e.g. `kobe-server`, `kaiju-gateway`).
   */
  readonly applicationName?: string;
  /** How long to wait for a free pooled connection before failing (default 10 s). */
  readonly acquireTimeoutMs?: number;
}

/**
 * The `onConnect` hook of every app-role pool (KOBE-732): sets the session timeouts with `SET`
 * (not as startup parameters, which PgBouncer refuses), so they hold whatever the role's own
 * defaults are; `SET LOCAL` in a transaction still overrides.
 *
 * Postgres ends a session idle in a transaction with a FATAL error while the client is checked
 * out, when pg-pool has no listener on it: without one of its own the client's 'error' event would
 * crash the process. The hook logs that error with its SQLSTATE, keeps it on the client, and makes
 * every later query on the client fail with {@link IdleInTransactionTimeoutError} (or
 * {@link DatabaseConnectionLostError}) caused by it, instead of pg's "not queryable"; the pool then
 * drops the client.
 */
export function appSessionHook(
  options: AppSessionOptions = {},
): (client: pg.ClientBase) => Promise<void> {
  const statementTimeout = timeoutMs(options.statementTimeoutMs, APP_STATEMENT_TIMEOUT_MS);
  const idleTimeout = timeoutMs(
    options.idleInTransactionTimeoutMs,
    APP_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  );
  const log = options.onConnectionError ?? defaultConnectionErrorLog;
  return async (client) => {
    let lost: DatabaseConnectionLostError | undefined;
    client.on("error", (err: unknown) => {
      // The first error is the cause (a FATAL with its SQLSTATE); the socket's close follows.
      if (lost !== undefined) return;
      const sqlstate = (err as { code?: unknown } | null)?.code;
      const code = typeof sqlstate === "string" ? sqlstate : undefined;
      log(err, code);
      lost =
        code === IDLE_IN_TRANSACTION_SQLSTATE
          ? new IdleInTransactionTimeoutError(err)
          : new DatabaseConnectionLostError("the database connection was lost", err);
    });
    // Looked up on each call, not bound once: a later patch of the prototype (instrumentation,
    // the query-capturing plan tests) still applies.
    const proto = Object.getPrototypeOf(client) as { query: (...args: unknown[]) => unknown };
    (client as { query: unknown }).query = (...args: unknown[]): unknown => {
      if (lost === undefined) return proto.query.apply(client, args);
      const callback = args.at(-1);
      if (typeof callback === "function") {
        queueMicrotask(() => (callback as (err: Error) => void)(lost as Error));
        return undefined;
      }
      return Promise.reject(lost);
    };
    await client.query(
      `SET statement_timeout = ${statementTimeout}; ` +
        `SET idle_in_transaction_session_timeout = ${idleTimeout}`,
    );
  };
}

/** Default query pool size of a service (KOBE-736: `KOBE_DB_POOL_MAX` overrides it). */
export const DEFAULT_POOL_MAX = 10;

/** Connects as the app role. Team data is reachable only through `withTeam()`. */
export function createDb(connectionString: string, options: CreateDbOptions = {}): KaijuDatabase {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? DEFAULT_POOL_MAX,
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
    connectionTimeoutMillis: options.acquireTimeoutMs ?? 10_000,
    // Awaited by the pool before it hands the connection out (a failure fails the acquire).
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg-pool 3.x awaits the hook; @types/pg says void
    onConnect: appSessionHook(options),
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
