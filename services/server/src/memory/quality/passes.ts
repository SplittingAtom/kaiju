import { scanTeams, sql, withTeam, type KaijuDb, type KaijuTx } from "@kaiju/db";
import { notAllowed } from "../items/errors.js";
import { curates, type MemoryWho } from "../items/who.js";

/** Learning passes counted: those that finished in the last 30 days. */
export const PASS_WINDOW_DAYS = 30;

/** Counts only: what Learn offered and what people did with it (SM22, SM30). */
export type PassSignals = {
  /** Passes that finished (completed or failed). */
  readonly passes: number;
  readonly failed: number;
  /** Candidates shown in To review. */
  readonly shown: number;
  readonly saved: number;
  readonly proposed: number;
  readonly suggested: number;
  readonly dismissed: number;
  readonly expired: number;
  /** Still open in To review. */
  readonly open: number;
  /** Saved after the person changed the statement, kind or scope (audit `edited`). */
  readonly edited_before_save: number;
};

export interface WorkspacePassSignalsResponse {
  readonly window_days: number;
  readonly signals: PassSignals;
}

export interface SitePassSignalsResponse {
  readonly window_days: number;
  readonly totals: PassSignals;
  /** Workspaces with at least one pass in the window, most passes first. */
  readonly workspaces: readonly ({
    readonly team_id: string;
    readonly name: string;
  } & PassSignals)[];
}

const EMPTY: PassSignals = {
  passes: 0,
  failed: 0,
  shown: 0,
  saved: 0,
  proposed: 0,
  suggested: 0,
  dismissed: 0,
  expired: 0,
  open: 0,
  edited_before_save: 0,
};
const FIELDS = Object.keys(EMPTY) as (keyof PassSignals)[];

/**
 * One Workspace's numbers: passes by `memory_learning_passes_finished_idx`, their candidates by
 * the `(team_id, pass_id, ord)` unique index, and edited saves from the audit log's
 * `memory.candidate.accepted` events of those passes (ids and flags only; no text).
 */
async function teamSignals(tx: KaijuDb | KaijuTx, teamId: string): Promise<PassSignals> {
  const { rows } = await tx.execute<PassSignals>(sql`
    WITH p AS (
      SELECT id, status FROM memory_learning_passes
       WHERE team_id = ${teamId} AND finished_at IS NOT NULL
         AND finished_at >= now() - make_interval(days => ${PASS_WINDOW_DAYS})
    ), c AS (
      SELECT c.state FROM memory_candidates c JOIN p ON c.pass_id = p.id
       WHERE c.team_id = ${teamId}
    )
    SELECT (SELECT count(*)::int FROM p) AS passes,
           (SELECT count(*)::int FROM p WHERE status = 'failed') AS failed,
           (SELECT count(*)::int FROM c) AS shown,
           (SELECT count(*)::int FROM c WHERE state = 'saved') AS saved,
           (SELECT count(*)::int FROM c WHERE state = 'proposed') AS proposed,
           (SELECT count(*)::int FROM c WHERE state = 'suggested') AS suggested,
           (SELECT count(*)::int FROM c WHERE state = 'dismissed') AS dismissed,
           (SELECT count(*)::int FROM c WHERE state = 'expired') AS expired,
           (SELECT count(*)::int FROM c WHERE state = 'open') AS open,
           (SELECT count(*)::int FROM audit_log a
             WHERE a.team_id = ${teamId} AND a.action = 'memory.candidate.accepted'
               AND a.at >= now() - make_interval(days => ${PASS_WINDOW_DAYS})
               AND a.target ->> 'edited' = 'true'
               AND a.target ->> 'passId' IN (SELECT id::text FROM p)) AS edited_before_save`);
  return rows[0] ?? EMPTY;
}

/** The active Workspace's pass signals (KOBE-411): Workspace curators only. */
export async function workspacePassSignals(
  db: KaijuDb,
  who: MemoryWho,
): Promise<WorkspacePassSignalsResponse> {
  if (!curates(who, "team") || who.teamId === null)
    throw notAllowed("Only Team admins and memory stewards see Learn's numbers.");
  const teamId = who.teamId;
  const signals = await withTeam(db, teamId, (tx) => teamSignals(tx, teamId));
  return { window_days: PASS_WINDOW_DAYS, signals };
}

/**
 * Every Workspace's pass signals and their sum, for Site curators (KOBE-411). The wall (SM20):
 * numbers and Workspace names only, never a statement, thread or person.
 */
export async function sitePassSignals(
  db: KaijuDb,
  who: MemoryWho,
): Promise<SitePassSignalsResponse> {
  if (!curates(who, "site"))
    throw notAllowed("Only Site admins and Site memory stewards see Learn's numbers.");
  const workspaces = await scanTeams(db, "sitePassSignals", async (tx, team) => {
    const s = await teamSignals(tx, team.id);
    return s.passes > 0 ? { team_id: team.id, name: team.name, ...s } : undefined;
  });
  const totals = Object.fromEntries(
    FIELDS.map((f) => [f, workspaces.reduce((n, w) => n + w[f], 0)]),
  ) as unknown as PassSignals;
  workspaces.sort((a, b) => b.passes - a.passes || a.name.localeCompare(b.name));
  return { window_days: PASS_WINDOW_DAYS, totals, workspaces };
}
