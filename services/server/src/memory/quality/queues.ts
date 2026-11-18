import { sql, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { notAllowed } from "../items/errors.js";
import { curates, type MemoryWho } from "../items/who.js";

/** Decisions counted for the median time to decision: the last 30 days. */
export const QUEUE_WINDOW_DAYS = 30;

export type QueueName = "workspace_proposals" | "project_suggestions" | "site_proposals";

export interface QueueHealth {
  readonly queue: QueueName;
  readonly pending: number;
  readonly oldest_pending_at: string | null;
  /** Decisions by a person (not expiries) in the window. */
  readonly decided: number;
  /** Median seconds from waiting to decided, over those decisions; null without any. */
  readonly median_decision_seconds: number | null;
}

export interface QueueHealthResponse {
  readonly window_days: number;
  readonly queues: readonly QueueHealth[];
}

type Row = {
  pending: number;
  oldest: Date | string | null;
  decided: number;
  median: number | string | null;
};

const toHealth = (queue: QueueName, r: Row | undefined): QueueHealth => ({
  queue,
  pending: r?.pending ?? 0,
  oldest_pending_at: r?.oldest ? new Date(r.oldest).toISOString() : null,
  decided: r?.decided ?? 0,
  median_decision_seconds:
    r?.median === null || r?.median === undefined ? null : Math.round(Number(r.median)),
});

const cutoff = sql`now() - make_interval(days => ${QUEUE_WINDOW_DAYS})`;

/**
 * One queue's numbers from `table` (state index leading): `pending` rows waiting since `since`,
 * decisions in `decided` states by a person (`decided_by` set) with `decided_at` in the window.
 */
async function queue(
  tx: KobeDb | KobeTx,
  name: QueueName,
  from: ReturnType<typeof sql>,
  pending: ReturnType<typeof sql>,
  since: ReturnType<typeof sql>,
  decided: ReturnType<typeof sql>,
): Promise<QueueHealth> {
  const { rows } = await tx.execute<Row>(sql`
    SELECT (SELECT count(*)::int FROM ${from} WHERE ${pending}) AS pending,
           (SELECT min(${since}) FROM ${from} WHERE ${pending}) AS oldest,
           d.decided, d.median
      FROM (SELECT count(*)::int AS decided,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM decided_at - ${since})) AS median
              FROM ${from}
             WHERE ${decided} AND decided_by IS NOT NULL AND decided_at >= ${cutoff}) d`);
  return toHealth(name, rows[0]);
}

/**
 * Workspace queue health (KOBE-411): members' proposals to the Workspace (KOBE-397) and readers'
 * project-note suggestions (KOBE-652). Workspace curators only.
 */
export async function workspaceQueueHealth(
  db: KobeDb,
  who: MemoryWho,
): Promise<QueueHealthResponse> {
  if (!curates(who, "team") || who.teamId === null)
    throw notAllowed("Only Team admins and memory stewards see the Workspace's queues.");
  const teamId = who.teamId;
  const queues = await withTeam(db, teamId, async (tx) => [
    await queue(
      tx,
      "workspace_proposals",
      sql`memory_proposals`,
      sql`team_id = ${teamId} AND state = 'pending'`,
      sql`created_at`,
      sql`team_id = ${teamId} AND state IN ('approved', 'rejected')`,
    ),
    await queue(
      tx,
      "project_suggestions",
      sql`memory_project_suggestions`,
      sql`team_id = ${teamId} AND state = 'pending'`,
      sql`created_at`,
      sql`team_id = ${teamId} AND state IN ('approved', 'dismissed')`,
    ),
  ]);
  return { window_days: QUEUE_WINDOW_DAYS, queues };
}

/**
 * Site queue health (KOBE-411): proposals a Team admin confirmed, waiting for the Site
 * (`awaiting_site`), timed from the last confirmation. Site admins and Site memory stewards only.
 * Numbers only: no statement, Workspace or person.
 */
export async function siteQueueHealth(db: KobeDb, who: MemoryWho): Promise<QueueHealthResponse> {
  if (!curates(who, "site"))
    throw notAllowed("Only Site admins and Site memory stewards see the Site's queue.");
  const since = sql`coalesce(team_confirmed_at, created_at)`;
  const site = await queue(
    db,
    "site_proposals",
    sql`site_memory_proposals`,
    sql`state = 'awaiting_site'`,
    since,
    sql`state IN ('approved', 'merged', 'rejected')`,
  );
  return { window_days: QUEUE_WINDOW_DAYS, queues: [site] };
}
