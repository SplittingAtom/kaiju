import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { threadStatsSchema, type ThreadStats } from "@kaiju/protocol";
import { admin, as, finance, ids, newThread, useThreadsApp } from "./threads.test-helpers.js";

/**
 * KOBE-842: `GET /v1/threads/{id}/stats` aggregates the thread's runs, entries, approvals, model
 * calls and kept run events correctly, and only for those who may read the thread.
 */
useThreadsApp();

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);

let thread = "";
let other = "";

async function run(
  threadId: string,
  over: {
    status: string;
    kind?: string;
    startMs?: number;
    durationMs?: number;
    thinking?: string | null;
    skills?: string[];
    folded?: boolean;
    retryOf?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const ended = !["queued", "running", "waiting_approval"].includes(over.status);
  const start = over.startMs ?? 0;
  const kind = over.kind ?? "message";
  await admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, kind, status, started_at, ended_at,
                       thinking_level, skills_used, events_compacted_at, retry_of_run_id, created_at)
     VALUES ($1, $2, $3, 'user', $4, $5, $6, $7, $8, $9, $10, $11, $6)`,
    [
      finance,
      id,
      threadId,
      kind,
      over.status,
      at(start),
      ended ? at(start + (over.durationMs ?? 1000)) : null,
      over.thinking ?? null,
      JSON.stringify(
        (over.skills ?? []).map((name, i) => ({ tool_call_id: `s${i}`, name, source: "team" })),
      ),
      over.folded ? at(start + 10_000_000) : null,
      over.retryOf ?? null,
    ],
  );
  return id;
}

async function event(runId: string, type: string, payload: object, ms: number): Promise<void> {
  await admin.query(
    `INSERT INTO run_events (team_id, run_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [finance, runId, type, JSON.stringify(payload), at(ms)],
  );
}

let entrySeq = 0;
async function entry(threadId: string, type: string, payload: object): Promise<void> {
  entrySeq += 1;
  await admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, $3, NULL, $4, $5)`,
    [finance, threadId, `e${entrySeq}`, type, JSON.stringify({ type, ...payload })],
  );
}

const assistant = (...tools: string[]) => ({
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      ...tools.map((name, i) => ({ type: "toolCall", id: `c${entrySeq}-${i}`, name })),
    ],
  },
});
const result = (name: string, isError: boolean) => ({
  message: { role: "toolResult", toolCallId: "x", toolName: name, isError, content: [] },
});

async function usage(
  runId: string,
  over: {
    model?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cost?: number | null;
    reasoning?: number | null;
    estimated?: boolean;
    kind?: string;
  },
): Promise<void> {
  await admin.query(
    `INSERT INTO run_usage (team_id, user_id, sandbox_id, kind, run_id, thread_id, route, model, status,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                            reasoning_tokens, reasoning_estimated, usage_source, cost_usd, duration_ms)
     VALUES ($1, $2, $13, $3, $4, $5, 'openai', $6, 200, $7, $8, $9, 0, $10, $11, 'reported', $12, 500)`,
    [
      finance,
      ids.bob,
      over.kind ?? "run",
      runId,
      thread,
      over.model ?? "prov/m1",
      over.input ?? 0,
      over.output ?? 0,
      over.cacheRead ?? 0,
      over.reasoning ?? null,
      over.estimated ?? false,
      over.cost === undefined ? 0.01 : over.cost,
      (over.kind ?? "run") === "run" ? randomUUID() : null,
    ],
  );
}

async function approval(runId: string, status: "pending" | "denied" | "expired" | "allowed") {
  const decided = status !== "pending";
  await admin.query(
    `INSERT INTO approvals (team_id, run_id, thread_id, connection_id, user_id, tool_call_id, tool,
                            input_canonical, risk, reasons, status, cause, decided_by, decided_at,
                            expires_at, token_kid, token_expires_at, input_hmac)
     VALUES ($1, $2, $3, $4, $5, $6, 'bash', '{}', 'write', '[]', $7, $8, $9, $10,
             now() + interval '1 hour', $11, $12, $13)`,
    [
      finance,
      runId,
      thread,
      randomUUID(),
      ids.bob,
      randomUUID(),
      status,
      !decided ? null : status === "expired" ? "ttl" : "user",
      status === "allowed" || status === "denied" ? ids.bob : null,
      decided ? new Date() : null,
      status === "allowed" ? "k1" : null,
      status === "allowed" ? new Date(Date.now() + 60_000) : null,
      status === "allowed" ? "a".repeat(43) : null,
    ],
  );
}

beforeAll(async () => {
  thread = await newThread(as.bob, { title: "stats" });
  other = await newThread(as.bob, { title: "empty" });

  // Turns: two completed (one with thinking high), one failed with kept events, one failed whose
  // events were folded, one retry, one running; plus a compaction run (not a turn).
  const r1 = await run(thread, {
    status: "completed",
    startMs: 0,
    durationMs: 1000,
    thinking: "high",
    skills: ["xlsx", "pdf"],
  });
  const r2 = await run(thread, {
    status: "completed",
    startMs: 10_000,
    durationMs: 3000,
    thinking: "off",
    skills: ["xlsx"],
  });
  const r3 = await run(thread, {
    status: "failed",
    startMs: 20_000,
    durationMs: 2000,
    thinking: "low",
  });
  await run(thread, {
    status: "failed",
    startMs: 30_000,
    durationMs: 5000,
    folded: true,
  });
  await run(thread, { status: "interrupted", startMs: 40_000, durationMs: 4000 });
  await run(thread, { status: "completed", startMs: 50_000, durationMs: 10_000, retryOf: r3 });
  await run(thread, { status: "running", startMs: 70_000 });
  await run(thread, {
    status: "completed",
    kind: "compaction",
    startMs: 80_000,
    durationMs: 60_000,
  });

  // Kept events: first tokens after 200 ms (r1), 600 ms (r2), 400 ms (r3); refusals; failure code.
  await event(r1, "run.started", {}, 0);
  await event(r1, "tool.call", {}, 50);
  await event(r1, "text.delta", {}, 200);
  await event(r1, "text.delta", {}, 900);
  await event(r1, "policy.denied", { tool_call_id: "p1", tool: "bash", reasons: [] }, 300);
  await event(r2, "reasoning.delta", {}, 10_600);
  await event(r3, "text.delta", {}, 20_400);
  await event(r3, "policy.denied", { tool_call_id: "p2", tool: "bash", reasons: [] }, 20_500);
  await event(r3, "run.failed", { error: { code: "model_error", message: "x" } }, 21_000);
  // A scheduled run's skipped action (kept with the run, not an event): counted once.
  await admin.query(
    `INSERT INTO run_skipped_actions (team_id, run_id, tool_call_id, tool, risk_class, reason)
     VALUES ($1, $2, 'p9', 'bash', 'write', 'scheduled_run')`,
    [finance, r2],
  );

  // Entries: 5 tool calls (3 MCP over two connectors), 2 failed results, compaction, summary.
  await entry(thread, "message", assistant("bash", "mcp__jira__create_issue"));
  await entry(thread, "message", assistant("mcp__catalyst_2__query", "mcp__jira__search", "read"));
  await entry(thread, "message", result("bash", true));
  await entry(thread, "message", result("read", true));
  await entry(thread, "message", result("mcp__jira__search", false));
  await entry(thread, "compaction", { summary: "s" });
  await entry(thread, "branch_summary", { summary: "s" });
  await entry(other, "message", assistant("bash"));

  // Model calls: two models; one unpriced; reasoning split on one call.
  await usage(r1, {
    model: "prov/m1",
    input: 100,
    output: 50,
    cacheRead: 1000,
    reasoning: 20,
    cost: 0.25,
  });
  await usage(r2, {
    model: "prov/m1",
    input: 200,
    output: 70,
    reasoning: 5,
    estimated: true,
    cost: 0.5,
  });
  await usage(r3, { model: "prov/m2", input: 10, output: 0, cost: null });
  // The server's title call is not a turn's call.
  await usage(r1, { model: "prov/m9", input: 9999, output: 9999, kind: "title" });

  await approval(r1, "allowed");
  await approval(r1, "denied");
  await approval(r2, "expired");
  await approval(r3, "pending");
}, 120_000);

async function stats(who: keyof typeof as, threadId: string) {
  const res = await as[who].get(`/v1/threads/${threadId}/stats`);
  return res;
}

describe("GET /v1/threads/{id}/stats (KOBE-842)", () => {
  it("aggregates the thread's runs, tool calls, approvals, usage and kept events", async () => {
    const res = await stats("bob", thread);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const parsed = threadStatsSchema.safeParse(res.json);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    const s = parsed.data as ThreadStats;
    expect(s.conversation).toEqual({
      turns: 7,
      outcomes: {
        completed: 3,
        failed: 2,
        interrupted: 1,
        cancelled: 0,
        budget_stopped: 0,
        in_progress: 1,
      },
      retries: 1,
      compactions: 1,
      branch_summaries: 1,
      failures_by_code: [{ name: "model_error", count: 1 }],
      models: [
        { name: "prov/m1", count: 2 },
        { name: "prov/m2", count: 1 },
      ],
    });
    expect(s.tools).toEqual({
      calls: 5,
      failed: 2,
      refused: 3,
      approvals: { asked: 4, allowed: 1, denied: 1, expired: 1, pending: 1 },
      skills: {
        uses: 3,
        names: [
          { name: "xlsx", count: 2 },
          { name: "pdf", count: 1 },
        ],
      },
      mcp: [
        { name: "jira", count: 2 },
        { name: "catalyst_2", count: 1 },
      ],
    });
    expect(s.tokens).toEqual({
      calls: 3,
      input: 310,
      output: 120,
      cache_read: 1000,
      cache_write: 0,
      reasoning: 25,
      reasoning_estimated: true,
      runs_with_reasoning: 2,
      thinking_levels: expect.arrayContaining([
        { level: "high", count: 1 },
        { level: "off", count: 1 },
        { level: "low", count: 1 },
      ]),
      cost_usd: 0.75,
      unpriced_calls: 1,
    });
    // First tokens 200, 400, 600 ms; durations 1, 2, 3, 4, 5, 10 s (the compaction is no turn).
    expect(s.performance.first_token).toEqual({ median_ms: 400, p95_ms: 580, samples: 3 });
    expect(s.performance.duration).toEqual({ median_ms: 3500, p95_ms: 8750, samples: 6 });
    expect(s.events).toEqual({ kept: 5, folded: 1 });
  });

  it("answers zeros, empty lists and nulls for a thread with no turns", async () => {
    const res = await stats("bob", other);
    expect(res.status).toBe(200);
    const s = res.json as ThreadStats;
    expect(s.conversation.turns).toBe(0);
    expect(s.conversation.failures_by_code).toEqual([]);
    expect(s.tools.calls).toBe(1);
    expect(s.tools.refused).toBe(0);
    expect(s.tokens.reasoning).toBeNull();
    expect(s.tokens.cost_usd).toBe(0);
    expect(s.performance).toEqual({ first_token: null, duration: null });
  });

  it("says not recorded when every failed turn's events were folded away", async () => {
    const t = await newThread(as.bob, { title: "old" });
    await run(t, { status: "failed", folded: true });
    const s = (await stats("bob", t)).json as ThreadStats;
    expect(s.conversation.failures_by_code).toBeNull();
    expect(s.tools.refused).toBeNull();
    expect(s.performance.first_token).toBeNull();
    expect(s.performance.duration).toEqual({ median_ms: 1000, p95_ms: 1000, samples: 1 });
  });

  it("is the usual 404 for another team's member and a teammate it is not shared with", async () => {
    // dave is in marketing only; carol is in finance and the thread is private to bob.
    expect((await stats("dave", thread)).status).toBe(404);
    expect((await stats("carol", thread)).status).toBe(404);
    expect((await stats("alice", thread)).status).toBe(404);
  });

  it("is readable by a teammate once it is shared with the team, and not after unsharing", async () => {
    const shared = await as.bob.post(`/v1/threads/${thread}/share`, { visibility: "team" });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const res = await stats("carol", thread);
    expect(res.status).toBe(200);
    expect((res.json as ThreadStats).conversation.turns).toBe(7);
    const back = await as.bob.post(`/v1/threads/${thread}/share`, { visibility: "private" });
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect((await stats("carol", thread)).status).toBe(404);
  });

  it("refuses a bad id", async () => {
    expect((await stats("bob", "not-a-uuid")).status).toBe(400);
  });
});
