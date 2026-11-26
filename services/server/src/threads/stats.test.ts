import { describe, expect, it } from "vitest";
import type { KaijuTx } from "@kaiju/db";
import { threadStatsSchema } from "@kaiju/protocol";
import { readThreadStats } from "./stats.js";

/**
 * KOBE-842: how `readThreadStats` turns its aggregate rows into the wire answer: nulls for what is
 * not recorded, lists sorted and capped, numbers from Postgres' text. The SQL itself is proven
 * against Postgres in `threads.stats.db.test.ts`. The fake answers the statements in the order
 * they are sent: runs, thinking levels, skills, usage, models, entries, tool calls, approvals,
 * refusals, failure codes, first token.
 */
type Row = Record<string, unknown>;

function fakeTx(answers: readonly (readonly Row[])[]): KaijuTx {
  let i = 0;
  return {
    execute: async () => ({ rows: answers[i++] ?? [] }),
  } as unknown as KaijuTx;
}

const THREAD = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-25T12:00:00.000Z");

function answers(over: Partial<Record<number, readonly Row[]>> = {}) {
  const base: (readonly Row[])[] = [
    [{ turns: "0", failed: "0", failed_kept: "0", events_live: "0", samples: "0" }],
    [],
    [],
    [{ calls: "0", cost_usd: "0.0000000000", unpriced_calls: "0", reasoning: null }],
    [],
    [{ compactions: "0", branch_summaries: "0", failed: "0" }],
    [],
    [{ asked: "0" }],
    [{ refused: "0", skipped: "0" }],
    [],
    [{ samples: "0" }],
  ];
  return base.map((rows, i) => over[i] ?? rows);
}

describe("readThreadStats", () => {
  it("answers a valid empty answer for a thread with nothing yet", async () => {
    const s = await readThreadStats(fakeTx(answers()), "team", THREAD, NOW);
    expect(threadStatsSchema.safeParse(s).success).toBe(true);
    expect(s.as_of).toBe(NOW.toISOString());
    expect(s.conversation.failures_by_code).toEqual([]);
    expect(s.tools.refused).toBe(0);
    expect(s.tokens.reasoning).toBeNull();
    expect(s.tokens.cost_usd).toBe(0);
    expect(s.performance).toEqual({ first_token: null, duration: null });
  });

  it("says not recorded when the events of every turn were folded away", async () => {
    const s = await readThreadStats(
      fakeTx(
        answers({
          0: [{ turns: "3", failed: "2", failed_kept: "0", events_live: "0", events_folded: "3" }],
        }),
      ),
      "team",
      THREAD,
      NOW,
    );
    expect(s.conversation.failures_by_code).toBeNull();
    expect(s.tools.refused).toBeNull();
    expect(s.events).toEqual({ kept: 0, folded: 3 });
  });

  it("keeps refusals known when a scheduled run's skipped action was recorded", async () => {
    const s = await readThreadStats(
      fakeTx(
        answers({
          0: [{ turns: "1", events_live: "0" }],
          8: [{ refused: "2", skipped: "2" }],
        }),
      ),
      "team",
      THREAD,
      NOW,
    );
    expect(s.tools.refused).toBe(2);
  });

  it("gives no cost when every call was unpriced, and the sum otherwise", async () => {
    const unpriced = await readThreadStats(
      fakeTx(answers({ 3: [{ calls: "2", unpriced_calls: "2", cost_usd: "0.0000000000" }] })),
      "team",
      THREAD,
      NOW,
    );
    expect(unpriced.tokens.cost_usd).toBeNull();
    const priced = await readThreadStats(
      fakeTx(answers({ 3: [{ calls: "2", unpriced_calls: "1", cost_usd: "0.1250000000" }] })),
      "team",
      THREAD,
      NOW,
    );
    expect(priced.tokens.cost_usd).toBe(0.125);
    expect(priced.tokens.unpriced_calls).toBe(1);
  });

  it("sorts and caps name lists, groups tool calls by connector and rounds percentiles", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `s${i}`, count: String(i % 3) }));
    const s = await readThreadStats(
      fakeTx(
        answers({
          0: [{ turns: "2", events_live: "2", median_ms: 1234.4, p95_ms: 5678.9, samples: "2" }],
          1: [
            { level: "high", count: "1" },
            { level: "bogus", count: "1" },
          ],
          2: many,
          6: [
            { name: null, count: "4" },
            { name: "jira", count: "2" },
            { name: "catalyst_2", count: "3" },
          ],
          10: [{ median_ms: 400, p95_ms: 580.4, samples: "3" }],
        }),
      ),
      "team",
      THREAD,
      NOW,
    );
    expect(threadStatsSchema.safeParse(s).success).toBe(true);
    expect(s.tools.calls).toBe(9);
    expect(s.tools.mcp).toEqual([
      { name: "catalyst_2", count: 3 },
      { name: "jira", count: 2 },
    ]);
    expect(s.tools.skills.names).toHaveLength(64);
    expect(s.tools.skills.names[0]?.count).toBe(2);
    expect(s.tokens.thinking_levels).toEqual([{ level: "high", count: 1 }]);
    expect(s.performance.duration).toEqual({ median_ms: 1234, p95_ms: 5679, samples: 2 });
    expect(s.performance.first_token).toEqual({ median_ms: 400, p95_ms: 580, samples: 3 });
  });
});
