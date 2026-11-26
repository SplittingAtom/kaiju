import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";
import { thinkingLevelSchema } from "./thinking.js";

/**
 * Conversation stats (KOBE-842): `GET /v1/threads/{id}/stats` answers {@link threadStatsSchema},
 * aggregated from what Kaiju already stores about the thread (its runs, entries, approvals and
 * model calls) for whoever may read the thread. Every branch of the conversation counts.
 *
 * A figure Kaiju does not have is `null`, never 0: the Context panel says "Not recorded". Figures
 * read from a run's live events (`refused`, `failures_by_code`, `first_token`) cover only turns
 * whose events are still kept (`events.kept`); events are folded away 7 days after a turn ends
 * (D18), and those turns are counted in `events.folded`.
 */

/** Longest name list a stats answer carries (models, skills, connectors, failure codes). */
export const THREAD_STATS_LIST_MAX = 64;

const count = z.number().int().nonnegative();

/** A name and how often it occurs, most frequent first. */
export const threadStatsNamedCountSchema = z.strictObject({
  name: z.string().min(1).max(256),
  count,
});
export type ThreadStatsNamedCount = z.infer<typeof threadStatsNamedCountSchema>;

const namedCounts = z.array(threadStatsNamedCountSchema).max(THREAD_STATS_LIST_MAX);

/** Median and 95th percentile of a duration in milliseconds over `samples` turns. */
export const threadStatsSpreadSchema = z.strictObject({
  median_ms: count,
  p95_ms: count,
  samples: count.min(1),
});
export type ThreadStatsSpread = z.infer<typeof threadStatsSpreadSchema>;

export const threadStatsSchema = z.strictObject({
  thread_id: uuidSchema,
  /** When the figures were read. */
  as_of: timestampSchema,
  conversation: z.strictObject({
    /** Message runs (turns); compactions, branch summaries and notebook runs are not turns. */
    turns: count,
    outcomes: z.strictObject({
      completed: count,
      failed: count,
      interrupted: count,
      cancelled: count,
      budget_stopped: count,
      /** Queued, running or waiting for an approval. */
      in_progress: count,
    }),
    /** Turns that retried an interrupted one. */
    retries: count,
    /** Compaction entries (automatic or Compact now). */
    compactions: count,
    branch_summaries: count,
    /** Failed turns by error code, from kept events; null when no failed turn's events are kept. */
    failures_by_code: namedCounts.nullable(),
    /** The thread's model calls by model (`<gateway provider>/<model>`). */
    models: namedCounts,
  }),
  tools: z.strictObject({
    /** Tool calls the model made. */
    calls: count,
    /** Tool results that were errors (refused and denied calls included). */
    failed: count,
    /** Calls the server's policy refused (kept events and scheduled runs' skipped actions). */
    refused: count.nullable(),
    approvals: z.strictObject({
      asked: count,
      allowed: count,
      denied: count,
      /** Not decided in time, or the turn ended first. */
      expired: count,
      pending: count,
    }),
    /** Skills the turns used (a SKILL.md read), by name. */
    skills: z.strictObject({ uses: count, names: namedCounts }),
    /** Calls to MCP connector tools (`mcp__<connector>__<tool>`), by connector. */
    mcp: namedCounts,
  }),
  tokens: z.strictObject({
    /** The turns' own model calls (title and follow-up calls are not counted). */
    calls: count,
    /** Input tokens not read from or written to a prompt cache. */
    input: count,
    output: count,
    cache_read: count,
    cache_write: count,
    /** Reasoning tokens within `output`; null when no call reported or showed reasoning. */
    reasoning: count.nullable(),
    /** Some of `reasoning` is estimated from the reasoning text. */
    reasoning_estimated: z.boolean(),
    /** Turns with thinking on (a level other than off). */
    runs_with_reasoning: count,
    /** Turns by thinking level; turns on a model without a thinking control are left out. */
    thinking_levels: z
      .array(z.strictObject({ level: thinkingLevelSchema, count }))
      .max(THREAD_STATS_LIST_MAX),
    /** Dollars at the catalog's prices; null when calls were made and none had a price. */
    cost_usd: z.number().nonnegative().nullable(),
    unpriced_calls: count,
  }),
  performance: z.strictObject({
    /** Turn start to its first streamed text or reasoning, over kept events; null: none. */
    first_token: threadStatsSpreadSchema.nullable(),
    /** Turn start to end, over ended turns; null: none. */
    duration: threadStatsSpreadSchema.nullable(),
  }),
  /** Ended turns whose live events are kept, and those whose events were folded away. */
  events: z.strictObject({ kept: count, folded: count }),
});
export type ThreadStats = z.infer<typeof threadStatsSchema>;

/** Stats reads per member per minute (the panel reads once per open and per Refresh). */
export const THREAD_STATS_RATE_LIMIT = { windowMs: 60_000, max: 30 } as const;
