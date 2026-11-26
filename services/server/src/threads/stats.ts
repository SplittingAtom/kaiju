import { currentModelSql, sql, type KaijuTx } from "@kaiju/db";
import {
  THREAD_STATS_LIST_MAX,
  thinkingLevelSchema,
  type ThreadStats,
  type ThreadStatsNamedCount,
  type ThreadStatsSpread,
} from "@kaiju/protocol";
import { costForDisplay } from "../models/usage-cost.js";

/**
 * Conversation stats (KOBE-842, `@kaiju/protocol` thread-stats.ts): one read of what Kaiju already
 * stores about a thread, aggregated in SQL inside the caller's `withTeam()` transaction (the
 * caller has checked the viewer may read the thread). Every statement names the team and the
 * thread and reads through a team-leading index: `runs_thread_idx`, `run_usage_thread_idx`,
 * `approvals_thread_idx`, `thread_entries`' primary key, and `run_events`' primary key per kept
 * run. Only counts, names of models, skills, connectors and error codes leave here, never content.
 */

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const LIST_MAX = THREAD_STATS_LIST_MAX;
const NAME_MAX = 256;

/** Rows of `name, count` as a list, most frequent first, names cut to the wire's limit. */
function namedCounts(rows: readonly Row[]): ThreadStatsNamedCount[] {
  return rows
    .filter((r) => typeof r.name === "string" && r.name.length > 0)
    .map((r) => ({ name: String(r.name).slice(0, NAME_MAX), count: num(r.count) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, LIST_MAX);
}

function spread(r: Row | undefined): ThreadStatsSpread | null {
  const samples = num(r?.samples);
  if (samples === 0 || r === undefined) return null;
  return {
    median_ms: Math.max(0, Math.round(num(r.median_ms))),
    p95_ms: Math.max(0, Math.round(num(r.p95_ms))),
    samples,
  };
}

const MESSAGE = sql.raw(`r.kind = 'message'`);
const ms = (from: string, to: string) => sql.raw(`extract(epoch FROM ${to} - ${from}) * 1000`);
const percentiles = (value: ReturnType<typeof ms>) => sql`
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ${value}) AS median_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY ${value}) AS p95_ms,
  count(${value}) AS samples`;

async function runFigures(tx: KaijuTx, teamId: string, threadId: string) {
  const ended = sql.raw(
    `r.kind = 'message' AND r.ended_at IS NOT NULL AND r.started_at IS NOT NULL`,
  );
  const res = await tx.execute<Row>(sql`
    SELECT count(*) FILTER (WHERE ${MESSAGE}) AS turns,
           count(*) FILTER (WHERE ${MESSAGE} AND r.status = 'completed') AS completed,
           count(*) FILTER (WHERE ${MESSAGE} AND r.status = 'failed') AS failed,
           count(*) FILTER (WHERE ${MESSAGE} AND r.status = 'interrupted') AS interrupted,
           count(*) FILTER (WHERE ${MESSAGE} AND r.status = 'cancelled') AS cancelled,
           count(*) FILTER (WHERE ${MESSAGE} AND r.status = 'budget_stopped') AS budget_stopped,
           count(*) FILTER (WHERE ${MESSAGE} AND r.ended_at IS NULL) AS in_progress,
           count(*) FILTER (WHERE ${MESSAGE} AND r.retry_of_run_id IS NOT NULL) AS retries,
           count(*) FILTER (WHERE ${MESSAGE} AND r.status = 'failed'
                              AND r.events_compacted_at IS NULL) AS failed_kept,
           count(*) FILTER (WHERE ${MESSAGE} AND r.events_compacted_at IS NULL) AS events_live,
           count(*) FILTER (WHERE ${MESSAGE} AND r.ended_at IS NOT NULL
                              AND r.events_compacted_at IS NULL) AS events_kept,
           count(*) FILTER (WHERE ${MESSAGE} AND r.events_compacted_at IS NOT NULL) AS events_folded,
           count(*) FILTER (WHERE ${MESSAGE} AND r.thinking_level IS NOT NULL
                              AND r.thinking_level <> 'off') AS runs_with_reasoning,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ms("r.started_at", "r.ended_at")})
             FILTER (WHERE ${ended}) AS median_ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ${ms("r.started_at", "r.ended_at")})
             FILTER (WHERE ${ended}) AS p95_ms,
           count(*) FILTER (WHERE ${ended}) AS samples
      FROM runs r
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid`);
  const levels = await tx.execute<Row>(sql`
    SELECT r.thinking_level AS level, count(*) AS count
      FROM runs r
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid AND ${MESSAGE}
       AND r.thinking_level IS NOT NULL
     GROUP BY r.thinking_level`);
  const skills = await tx.execute<Row>(sql`
    SELECT s.use ->> 'name' AS name, count(*) AS count
      FROM runs r
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(r.skills_used) = 'array' THEN r.skills_used ELSE '[]'::jsonb END)
             AS s(use)
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
     GROUP BY 1`);
  return { row: res.rows[0] ?? {}, levels: levels.rows, skills: skills.rows };
}

async function usageFigures(tx: KaijuTx, teamId: string, threadId: string) {
  const model = currentModelSql("u.model");
  const own = sql.raw(`u.kind IN ('run', 'eval')`);
  const res = await tx.execute<Row>(sql`
    SELECT count(*) AS calls,
           COALESCE(sum(u.input_tokens), 0) AS input,
           COALESCE(sum(u.output_tokens), 0) AS output,
           COALESCE(sum(u.cache_read_tokens), 0) AS cache_read,
           COALESCE(sum(u.cache_write_tokens), 0) AS cache_write,
           sum(u.reasoning_tokens) AS reasoning,
           COALESCE(bool_or(u.reasoning_estimated) FILTER (WHERE u.reasoning_tokens IS NOT NULL), false)
             AS reasoning_estimated,
           COALESCE(sum(u.cost_usd), 0)::numeric(30,10)::text AS cost_usd,
           count(*) FILTER (WHERE u.cost_usd IS NULL) AS unpriced_calls
      FROM run_usage u
     WHERE u.team_id = ${teamId}::uuid AND u.thread_id = ${threadId}::uuid AND ${own}`);
  const models = await tx.execute<Row>(sql`
    SELECT ${model} AS name, count(*) AS count
      FROM run_usage u
     WHERE u.team_id = ${teamId}::uuid AND u.thread_id = ${threadId}::uuid AND ${own}
     GROUP BY 1`);
  return { row: res.rows[0] ?? {}, models: models.rows };
}

async function entryFigures(tx: KaijuTx, teamId: string, threadId: string) {
  const m = sql.raw(`te.payload -> 'message'`);
  const res = await tx.execute<Row>(sql`
    SELECT count(*) FILTER (WHERE te.type = 'compaction') AS compactions,
           count(*) FILTER (WHERE te.type = 'branch_summary') AS branch_summaries,
           count(*) FILTER (WHERE te.type = 'message' AND ${m} ->> 'role' = 'toolResult'
                              AND (${m} -> 'isError') = 'true'::jsonb) AS failed
      FROM thread_entries te
     WHERE te.team_id = ${teamId}::uuid AND te.thread_id = ${threadId}::uuid`);
  // Tool calls grouped by MCP connector (`mcp__<connector>__<tool>`); null groups the others.
  const calls = await tx.execute<Row>(sql`
    SELECT CASE WHEN p.part ->> 'name' LIKE 'mcp\\_\\_%\\_\\_%'
                THEN split_part(p.part ->> 'name', '__', 2) END AS name,
           count(*) AS count
      FROM thread_entries te
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(${m} -> 'content') = 'array' THEN ${m} -> 'content'
                  ELSE '[]'::jsonb END) AS p(part)
     WHERE te.team_id = ${teamId}::uuid AND te.thread_id = ${threadId}::uuid
       AND te.type = 'message' AND ${m} ->> 'role' = 'assistant'
       AND p.part ->> 'type' = 'toolCall'
     GROUP BY 1`);
  return { row: res.rows[0] ?? {}, calls: calls.rows };
}

async function approvalFigures(tx: KaijuTx, teamId: string, threadId: string) {
  const res = await tx.execute<Row>(sql`
    SELECT count(*) AS asked,
           count(*) FILTER (WHERE a.status = 'allowed') AS allowed,
           count(*) FILTER (WHERE a.status = 'denied') AS denied,
           count(*) FILTER (WHERE a.status = 'expired') AS expired,
           count(*) FILTER (WHERE a.status = 'pending') AS pending
      FROM approvals a
     WHERE a.team_id = ${teamId}::uuid AND a.thread_id = ${threadId}::uuid`);
  return res.rows[0] ?? {};
}

/**
 * Figures only a run's live events hold (D18 folds them away 7 days after the run ends): policy
 * refusals (with scheduled runs' skipped actions, which are kept), failure codes and the time to
 * the first token. Each reads `run_events` by its primary key per kept run.
 */
async function eventFigures(tx: KaijuTx, teamId: string, threadId: string) {
  const refused = await tx.execute<Row>(sql`
    SELECT count(*) AS refused,
           count(*) FILTER (WHERE x.skipped) AS skipped
      FROM (
        SELECT r.id AS run_id, d.call_id, false AS skipped
          FROM runs r
         CROSS JOIN LATERAL (
                 -- OFFSET 0 keeps this a per-run primary key scan (never a scan of all events).
                 SELECT e.payload ->> 'tool_call_id' AS call_id
                   FROM run_events e
                  WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.type = 'policy.denied'
                 OFFSET 0) d
         WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
           AND r.events_compacted_at IS NULL
        UNION
        SELECT s.run_id, s.tool_call_id, true
          FROM runs r
          JOIN run_skipped_actions s ON s.team_id = r.team_id AND s.run_id = r.id
         WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid
           AND s.team_id = ${teamId}::uuid
      ) x`);
  const failures = await tx.execute<Row>(sql`
    SELECT f.code AS name, count(*) AS count
      FROM runs r
     CROSS JOIN LATERAL (
             SELECT COALESCE(e.payload -> 'error' ->> 'code', 'unknown') AS code
               FROM run_events e
              WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.type = 'run.failed'
              ORDER BY e.seq DESC LIMIT 1) f
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid AND ${MESSAGE}
       AND r.status = 'failed' AND r.events_compacted_at IS NULL
     GROUP BY 1`);
  const firstToken = await tx.execute<Row>(sql`
    SELECT ${percentiles(ms("r.started_at", "t.at"))}
      FROM runs r
     CROSS JOIN LATERAL (
             SELECT e.created_at AS at
               FROM run_events e
              WHERE e.team_id = r.team_id AND e.run_id = r.id
                AND e.type IN ('text.delta', 'reasoning.delta')
              ORDER BY e.seq LIMIT 1) t
     WHERE r.team_id = ${teamId}::uuid AND r.thread_id = ${threadId}::uuid AND ${MESSAGE}
       AND r.started_at IS NOT NULL AND r.events_compacted_at IS NULL`);
  return {
    refused: refused.rows[0] ?? {},
    failures: failures.rows,
    firstToken: firstToken.rows[0],
  };
}

/** The thread's stats; the caller is inside `withTeam(teamId)` and has checked visibility. */
export async function readThreadStats(
  tx: KaijuTx,
  teamId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<ThreadStats> {
  const runs = await runFigures(tx, teamId, threadId);
  const usage = await usageFigures(tx, teamId, threadId);
  const entries = await entryFigures(tx, teamId, threadId);
  const approvals = await approvalFigures(tx, teamId, threadId);
  const events = await eventFigures(tx, teamId, threadId);
  const r = runs.row;
  const u = usage.row;
  const calls = num(u.calls);
  const unpriced = num(u.unpriced_calls);
  const failed = num(r.failed);
  // Refusals are known when some turn's events are still kept, or a skipped action was recorded.
  const refusalsKnown =
    num(r.turns) === 0 || num(r.events_live) > 0 || num(events.refused.skipped) > 0;
  const toolCalls = entries.calls.reduce((sum, row) => sum + num(row.count), 0);
  const skills = namedCounts(runs.skills);
  return {
    thread_id: threadId,
    as_of: now.toISOString(),
    conversation: {
      turns: num(r.turns),
      outcomes: {
        completed: num(r.completed),
        failed,
        interrupted: num(r.interrupted),
        cancelled: num(r.cancelled),
        budget_stopped: num(r.budget_stopped),
        in_progress: num(r.in_progress),
      },
      retries: num(r.retries),
      compactions: num(entries.row.compactions),
      branch_summaries: num(entries.row.branch_summaries),
      failures_by_code:
        failed > 0 && num(r.failed_kept) === 0 ? null : namedCounts(events.failures),
      models: namedCounts(usage.models),
    },
    tools: {
      calls: toolCalls,
      failed: num(entries.row.failed),
      refused: refusalsKnown ? num(events.refused.refused) : null,
      approvals: {
        asked: num(approvals.asked),
        allowed: num(approvals.allowed),
        denied: num(approvals.denied),
        expired: num(approvals.expired),
        pending: num(approvals.pending),
      },
      skills: { uses: runs.skills.reduce((sum, row) => sum + num(row.count), 0), names: skills },
      mcp: namedCounts(entries.calls),
    },
    tokens: {
      calls,
      input: num(u.input),
      output: num(u.output),
      cache_read: num(u.cache_read),
      cache_write: num(u.cache_write),
      reasoning: u.reasoning === null || u.reasoning === undefined ? null : num(u.reasoning),
      reasoning_estimated: u.reasoning_estimated === true,
      runs_with_reasoning: num(r.runs_with_reasoning),
      thinking_levels: runs.levels.flatMap((row) => {
        const level = thinkingLevelSchema.safeParse(row.level);
        return level.success ? [{ level: level.data, count: num(row.count) }] : [];
      }),
      cost_usd: calls > 0 && unpriced === calls ? null : costForDisplay(String(u.cost_usd ?? "0")),
      unpriced_calls: unpriced,
    },
    performance: {
      first_token: spread(events.firstToken),
      duration: spread(r),
    },
    events: { kept: num(r.events_kept), folded: num(r.events_folded) },
  };
}
