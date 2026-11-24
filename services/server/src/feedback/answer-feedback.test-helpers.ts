// Shared setup for the answer-feedback.*.db.test.ts files
// (split from answer-feedback.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import type { ScoreSink, TraceScore } from "@kaiju/telemetry";
import type { GalleryDefinition } from "../gallery/definitions.js";
import { RunFixture, type RunWorld } from "../testing/run-fixture.js";
import type { Person } from "../testing/event-stream-fixture.js";

/**
 * KOBE-275: answer feedback through the API. Members rate answers they can see (the owner and
 * readers of a shared thread), each for themselves; changes and clears; agent owners and team
 * admins read count-only totals; ratings follow their thread (Trash purge, legal hold, export);
 * a Langfuse sink receives scores on the run's trace without the comment (capture off).
 */
export const ANY = { "if-match": "*" };
export const GALLERY: GalleryDefinition = {
  key: "fixture-rated",
  generation: 1,
  file: "---\nname: Fixture Rated\ndescription: A fixture for the rating tests\n---\nYou answer.\n",
};

export class RecordingSink implements ScoreSink {
  readonly calls: ({ op: "upsert"; score: TraceScore } | { op: "remove"; id: string })[] = [];
  upsert(score: TraceScore): Promise<void> {
    this.calls.push({ op: "upsert", score });
    return Promise.resolve();
  }
  remove(id: string): Promise<void> {
    this.calls.push({ op: "remove", id });
    return Promise.resolve();
  }
}

export const sink = new RecordingSink();
export const f = new RunFixture();

export const as = (p: Person) => f.on(0, p);
export const scores = async () => {
  for (const r of f.fx.replicas) await r.deps.feedbackScores?.idle();
  return sink.calls;
};

/** A team agent published by `builder`; returns its id. */
export async function publishedAgent(builder: Person): Promise<string> {
  const b = as(builder);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Rated ${randomUUID().slice(0, 6)}` },
    prompt: "You answer.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

/**
 * A team (admin `w.owner`), an author and a reader (plain members), and one finished answer by the
 * author on a thread pinned to a team agent the admin published.
 */
export async function world() {
  const w = await f.world();
  const author = await f.member(w.team);
  const reader = await f.member(w.team);
  const agentId = await publishedAgent(w.owner);
  const made = await as(author).post("/v1/threads", { agent_id: agentId });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const threadId = made.json.thread_id as string;
  const authorWorld: RunWorld = {
    team: w.team,
    owner: author,
    target: { teamId: w.team, userId: author.id },
  };
  const ws = await f.connect(authorWorld, 0);
  const answer = async (text: string) => {
    const runId = await f.message(author, threadId, text);
    const start = await ws.started(runId);
    const entries = ws.reply(start, `re: ${text}`);
    await ws.acked(runId);
    await f.until(w.team, runId, "completed");
    // The run's prompt entry is bound after the end commits (`onRunEnded` -> `bindUserEntry`, a
    // transaction of its own), so "completed" alone can still list `user_entry_id: null`.
    await expect
      .poll(async () => (await f.run(w.team, runId)).user_entry_id, { interval: 25 })
      .toBe(entries.user);
    return { runId, entries };
  };
  const first = await answer("hello");
  return {
    w,
    author,
    reader,
    agentId,
    threadId,
    ws,
    answer,
    runId: first.runId,
    entries: first.entries,
  };
}

export const rate = (p: Person, runId: string, body: Record<string, unknown>) =>
  as(p).put(`/v1/runs/${runId}/feedback`, body);
export const clear = (p: Person, runId: string) => as(p).delete(`/v1/runs/${runId}/feedback`);
export const mine = async (p: Person, threadId: string) => {
  const res = await as(p).get(`/v1/threads/${threadId}/feedback`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as {
    answers: {
      run_id: string;
      user_entry_id: string | null;
      feedback: Record<string, unknown> | null;
    }[];
  };
};

export const holdAdmins = new Map<string, { placer: string; approver: string }>();

export async function placeHold(teamId: string, userId: string | null): Promise<string> {
  const placer = await f.fx.person(`hp${randomUUID().slice(0, 4)}`);
  const approver = await f.fx.person(`ha${randomUUID().slice(0, 4)}`);
  for (const p of [placer, approver]) {
    await f.fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [p.id]);
  }
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, placer.id],
  );
  const id = rows[0]?.id ?? "";
  await f.fx.admin.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver.id],
  );
  holdAdmins.set(id, { placer: placer.id, approver: approver.id });
  return id;
}

export async function releaseHold(id: string): Promise<void> {
  const admins = holdAdmins.get(id);
  if (!admins) throw new Error(`no hold ${id}`);
  await f.fx.admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'closed' WHERE id = $1`,
    [id, admins.placer],
  );
  await f.fx.admin.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, admins.approver],
  );
}

/**
 * Ratings of `agentId` by `n` fresh members in `teamId`, written directly (one thread and ended
 * run each): enough raters for the totals without driving n sandboxes.
 */
export async function seedRatings(
  teamId: string,
  agent: { scope: string; id: string; version: number | null },
  n: number,
  values: {
    rating: "up" | "down";
    reasons?: string[];
    model?: string | null;
    /** When it was rated (default 1: yesterday, a finished day the totals include). */
    daysAgo?: number;
  },
): Promise<string[]> {
  const raters: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const userId = randomUUID();
    await f.fx.admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'r', $2)`, [
      userId,
      `${userId}@rate.test`,
    ]);
    const thread = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 't') RETURNING id`,
      [teamId, userId],
    );
    const threadId = thread.rows[0]?.id ?? "";
    const run = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
       VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
      [teamId, threadId],
    );
    await f.fx.admin.query(
      `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating, reasons,
         agent_scope, agent_id, agent_version, model_alias, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10,
         now() - make_interval(days => $11::int), now() - make_interval(days => $11::int))`,
      [
        teamId,
        threadId,
        run.rows[0]?.id,
        userId,
        values.rating,
        `{${(values.reasons ?? []).join(",")}}`,
        agent.scope,
        agent.id,
        agent.version,
        values.model ?? null,
        values.daysAgo ?? 1,
      ],
    );
    raters.push(userId);
  }
  return raters;
}

export const totals = async (p: Person, agentId: string, query = "") => {
  const res = await as(p).get(`/v1/agents/${agentId}/feedback${query}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res;
};

export const WITHHELD = { enough: false, up: null, down: null, rate: null };

/**
 * Registers the shared hooks; call once at the top level of each
 * answer-feedback.*.db.test.ts file.
 */
export function useAnswerFeedbackFixture(): void {
  beforeAll(async () => {
    await f.setup({ feedbackScores: { sink, captureContent: false } });
  });

  afterAll(async () => {
    await f.teardown();
  });
}
