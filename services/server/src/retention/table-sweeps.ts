import {
  JOB_STATEMENT_TIMEOUT,
  SYSTEM_ACTOR,
  lockLegalHolds,
  sql,
  withTeam,
  type KaijuDb,
  type KaijuTx,
} from "@kaiju/db";
import { recordAudit } from "../audit/record.js";
import { auditTimeout } from "./locks.js";

type SQL = ReturnType<typeof sql>;

/**
 * Retention of tables that otherwise grow for ever (KOBE-741, review STO-10; periods decided by
 * the owner 2026-11-20). Run by the nightly retention pass (`job.ts`), per team inside
 * `withTeam()`, in bounded batches: one `DELETE ... LIMIT` per short transaction, at most
 * {@link SWEEP_MAX_BATCHES} per table per team and pass (the next pass goes on), each audited with
 * the count only (`retention.table_swept`).
 *
 * - `events` (D15 happenings: schedule fires and skips, egress blocks, ...) older than
 *   `eventsDays`, only `processed` or `failed` ones (never `pending` work or a `scheduled` event),
 *   and never a schedule's latest fire or skip: the scheduler's skip dedupe reads it
 *   (`scheduler/fire.ts` latestEvent). The scheduler plans occurrences only inside its grace
 *   window (at most 24 h), so an older fire no longer guards anything. `events` is not the
 *   conversation record: threads live in `thread_entries`, and a run's live stream is
 *   `run_events` (compacted 7 days after the run, `compaction.ts`).
 * - `notifications` read longer ago than `readNotificationsDays`; unread ones are kept.
 * - `run_usage` older than `runUsageMonths`. Budgets and the spend views read the daily rollups
 *   (`model_spend_daily`, kept by an insert trigger), which keep their history. The ledger is
 *   append-only; its trigger lets this sweep delete rows older than 90 days only after it sets
 *   `kobe.run_usage_retention` for its own transaction (migration `*_run_usage_retention.sql`).
 * - `orbit_evals` (agent evals) finished longer ago than `evalHistoryMonths`, except an agent's
 *   latest eval (its score on the roster) and evals that published a version (the version's
 *   score).
 *
 * Legal holds: every batch takes the legal-hold lock first (a hold approved meanwhile waits; one
 * placed earlier wins). Rows of a held member are kept (`memory_legal_hold_covers`: a hold on the
 * member, or a team-wide hold); `events` name no member, so any active hold in the team keeps
 * them all. The audit log is kept (owner decision): no sweep.
 */

export interface TableSweepSettings {
  /** Days `events` are kept; null: never swept. */
  readonly eventsDays: number | null;
  /** Days a notification is kept after it was read; null: never swept. */
  readonly readNotificationsDays: number | null;
  /** Months `run_usage` rows are kept; null: never swept. */
  readonly runUsageMonths: number | null;
  /** Months finished agent evals are kept; null: never swept. */
  readonly evalHistoryMonths: number | null;
}

/** The owner's periods (2026-11-20). */
export const DEFAULT_TABLE_SWEEPS: TableSweepSettings = {
  eventsDays: 30,
  readNotificationsDays: 180,
  runUsageMonths: 13,
  evalHistoryMonths: 12,
};

/** Every sweep off (a pass without settings: tests, tools). */
export const NO_TABLE_SWEEPS: TableSweepSettings = {
  eventsDays: null,
  readNotificationsDays: null,
  runUsageMonths: null,
  evalHistoryMonths: null,
};

/** Bounds the config accepts (0 turns a sweep off). */
export const SWEEP_LIMITS = {
  /** Above the scheduler's longest grace window (24 h) plus a day. */
  eventsDays: { min: 2, max: 3650 },
  readNotificationsDays: { min: 1, max: 3650 },
  /** The ledger's trigger refuses rows younger than 90 days whatever is configured. */
  runUsageMonths: { min: 4, max: 120 },
  evalHistoryMonths: { min: 1, max: 120 },
} as const;

/** Rows one statement deletes at most. */
export const SWEEP_BATCH = 1000;
/** Batches per table per team in one pass (at most 50 000 rows); the next pass goes on. */
export const SWEEP_MAX_BATCHES = 50;

export const SWEPT_TABLES = ["events", "notifications", "run_usage", "orbit_evals"] as const;
export type SweptTable = (typeof SWEPT_TABLES)[number];

export type TableSweepCounts = Readonly<Record<SweptTable, number>>;

export const NO_TABLE_SWEEP_COUNTS: TableSweepCounts = {
  events: 0,
  notifications: 0,
  run_usage: 0,
  orbit_evals: 0,
};

export interface SweepOptions {
  readonly stop?: () => boolean;
  /**
   * A table's sweep failed (a lock timeout, say): called, then the other tables still run. Without
   * it the failure is rethrown after the remaining tables ran.
   */
  readonly onError?: (table: SweptTable, err: unknown) => void;
  readonly batch?: number;
  readonly maxBatches?: number;
}

/** The DELETE of one batch for `table`, or null when its sweep is off. */
function deleteStatement(
  table: SweptTable,
  teamId: string,
  settings: TableSweepSettings,
  limit: number,
): SQL | null {
  switch (table) {
    case "events": {
      if (settings.eventsDays === null) return null;
      return sql`
        DELETE FROM events e
         WHERE e.team_id = ${teamId} AND e.id IN (
           SELECT k.id FROM events k
            WHERE k.team_id = ${teamId}
              AND k.status IN ('processed', 'failed')
              AND k.created_at < now() - make_interval(days => ${settings.eventsDays})
              AND NOT public.memory_legal_hold_covers(k.team_id, NULL)
              AND (k.kind NOT IN ('schedule.fire', 'schedule.skip') OR k.schedule_id IS NULL
                   OR EXISTS (
                     SELECT 1 FROM events n
                      WHERE n.team_id = ${teamId} AND n.schedule_id = k.schedule_id
                        AND n.kind IN ('schedule.fire', 'schedule.skip')
                        AND (n.created_at > k.created_at
                             OR (n.created_at = k.created_at AND n.due_at > k.due_at))))
            ORDER BY k.created_at LIMIT ${limit})`;
    }
    case "notifications": {
      if (settings.readNotificationsDays === null) return null;
      return sql`
        DELETE FROM notifications n
         WHERE n.team_id = ${teamId} AND n.id IN (
           SELECT k.id FROM notifications k
            WHERE k.team_id = ${teamId} AND k.read_at IS NOT NULL
              AND k.read_at < now() - make_interval(days => ${settings.readNotificationsDays})
              AND NOT public.memory_legal_hold_covers(k.team_id, k.user_id)
            ORDER BY k.read_at LIMIT ${limit})`;
    }
    case "run_usage": {
      if (settings.runUsageMonths === null) return null;
      return sql`
        DELETE FROM run_usage u
         WHERE u.team_id = ${teamId} AND u.id IN (
           SELECT k.id FROM run_usage k
            WHERE k.team_id = ${teamId}
              AND k.at < now() - make_interval(months => ${settings.runUsageMonths})
              AND NOT public.memory_legal_hold_covers(k.team_id, k.user_id)
            ORDER BY k.at LIMIT ${limit})`;
    }
    case "orbit_evals": {
      if (settings.evalHistoryMonths === null) return null;
      return sql`
        DELETE FROM orbit_evals o
         WHERE o.team_id = ${teamId} AND o.id IN (
           SELECT k.id FROM orbit_evals k
            WHERE k.team_id = ${teamId}
              AND k.status IN ('passed', 'blocked', 'errored')
              AND k.version IS NULL
              AND k.created_at < now() - make_interval(months => ${settings.evalHistoryMonths})
              AND NOT public.memory_legal_hold_covers(k.team_id, k.requested_by)
              AND EXISTS (
                SELECT 1 FROM orbit_evals n
                 WHERE n.team_id = ${teamId} AND n.agent_id = k.agent_id
                   AND n.created_at > k.created_at)
            ORDER BY k.created_at LIMIT ${limit})`;
    }
  }
}

/** One batch of `table` in the team's transaction; returns the rows deleted. */
async function sweepBatch(
  tx: KaijuTx,
  teamId: string,
  table: SweptTable,
  statement: SQL,
): Promise<number> {
  // Before the hold lock: a pending hold approval must not make the sweep wait without bound.
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '5s'`));
  await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${JOB_STATEMENT_TIMEOUT}'`));
  if (table === "run_usage") {
    await tx.execute(sql`SELECT set_config('kobe.run_usage_retention', 'on', true)`);
  }
  await lockLegalHolds(tx);
  const res = await tx.execute(statement);
  const rows = res.rowCount ?? 0;
  if (rows > 0) {
    await auditTimeout(tx);
    await recordAudit(tx, {
      action: "retention.table_swept",
      actor: SYSTEM_ACTOR,
      teamId,
      target: { table, rows },
    });
  }
  return rows;
}

/** Sweeps one table of one team: batches until a short one, the batch cap or `stop`. */
export async function sweepTable(
  db: KaijuDb,
  teamId: string,
  table: SweptTable,
  settings: TableSweepSettings,
  options: SweepOptions = {},
): Promise<number> {
  const limit = options.batch ?? SWEEP_BATCH;
  const statement = deleteStatement(table, teamId, settings, limit);
  if (statement === null) return 0;
  let total = 0;
  for (let i = 0; i < (options.maxBatches ?? SWEEP_MAX_BATCHES); i++) {
    if (options.stop?.()) break;
    const rows = await withTeam(db, teamId, (tx) => sweepBatch(tx, teamId, table, statement));
    total += rows;
    if (rows < limit) break;
  }
  return total;
}

/**
 * Every table sweep of one team, in order. One table's failure never skips the others: it is
 * reported to `onError` (or rethrown once all tables ran) and that table counts 0.
 */
export async function sweepTables(
  db: KaijuDb,
  teamId: string,
  settings: TableSweepSettings,
  options: SweepOptions = {},
): Promise<TableSweepCounts> {
  const counts: Record<SweptTable, number> = { ...NO_TABLE_SWEEP_COUNTS };
  let failure: { readonly err: unknown } | undefined;
  for (const table of SWEPT_TABLES) {
    if (options.stop?.()) break;
    try {
      counts[table] = await sweepTable(db, teamId, table, settings, options);
    } catch (err) {
      if (options.onError) options.onError(table, err);
      else failure ??= { err };
    }
  }
  if (failure) throw failure.err;
  return counts;
}
