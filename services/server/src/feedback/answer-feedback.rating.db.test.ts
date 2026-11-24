import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runTraceId } from "@kaiju/protocol";
import type { TraceScore } from "@kaiju/telemetry";
import { FeedbackScores } from "./scores.js";
import {
  sink,
  f,
  as,
  scores,
  world,
  rate,
  clear,
  mine,
  useAnswerFeedbackFixture,
} from "./answer-feedback.test-helpers.js";

useAnswerFeedbackFixture();

describe("rating answers (ac-1)", () => {
  it("rates, changes and clears an answer; one rating per run and member; survives a reload", async () => {
    const x = await world();
    const listed = await mine(x.author, x.threadId);
    expect(listed.answers).toEqual([
      { run_id: x.runId, user_entry_id: expect.any(String), feedback: null, eval_case_id: null },
    ]);

    const up = await rate(x.author, x.runId, { rating: "up", entry_id: x.entries.assistant });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(up.json).toMatchObject({
      run_id: x.runId,
      thread_id: x.threadId,
      entry_id: x.entries.assistant,
      rating: "up",
      reasons: [],
      comment: null,
    });

    const down = await rate(x.author, x.runId, {
      rating: "down",
      reasons: ["wrong", "unsafe"],
      comment: "  It made the number up. ",
    });
    expect(down.status, JSON.stringify(down.json)).toBe(200);
    // A change without an entry keeps the stored one.
    expect(down.json).toMatchObject({
      rating: "down",
      reasons: ["wrong", "unsafe"],
      comment: "It made the number up.",
      entry_id: x.entries.assistant,
    });
    const rows = await f.fx.admin.query<Record<string, unknown>>(
      `SELECT user_id, agent_scope, agent_id, agent_version FROM answer_feedback WHERE team_id = $1`,
      [x.w.team],
    );
    expect(rows.rows).toEqual([
      { user_id: x.author.id, agent_scope: "team", agent_id: x.agentId, agent_version: 1 },
    ]);

    // A reload reads it back.
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toMatchObject({
      rating: "down",
      comment: "It made the number up.",
    });

    expect((await clear(x.author, x.runId)).status).toBe(204);
    expect((await clear(x.author, x.runId)).status).toBe(204);
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toBeNull();
    // Rating changes are not audited per click.
    expect((await f.auditActions(x.w.team)).filter((a) => a.includes("feedback"))).toEqual([]);
  });

  it("refuses what isn't a finished answer, a bad body, and another thread's entry", async () => {
    const x = await world();
    const bad = [
      { rating: "up", comment: "nice" },
      { rating: "up", reasons: ["wrong"] },
      { rating: "down", comment: "x".repeat(501) },
      { rating: "down", reasons: ["boring"] },
      { rating: "sideways" },
    ];
    for (const body of bad) {
      expect((await rate(x.author, x.runId, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await rate(x.author, randomUUID(), { rating: "up" })).json.code).toBe("run_not_found");
    expect((await rate(x.author, "not-a-uuid", { rating: "up" })).status).toBe(404);
    expect((await rate(x.author, x.runId, { rating: "up", entry_id: "nope" })).json.code).toBe(
      "entry_not_found",
    );
    // A run still going can't be rated yet.
    const running = await f.message(x.author, x.threadId, "again");
    await x.ws.started(running);
    const early = await rate(x.author, running, { rating: "up" });
    expect(early.status, JSON.stringify(early.json)).toBe(409);
    expect(early.json.code).toBe("run_not_ended");
  });
});

describe("who rates (ac-1)", () => {
  it("lets readers of a shared thread rate for themselves; nobody else sees or reaches it", async () => {
    const x = await world();
    const outsider = await f.member(x.w.team);
    // Private: the reader and the team admin can't rate (the same 404 as an unknown run).
    for (const p of [x.reader, x.w.owner]) {
      expect((await rate(p, x.runId, { rating: "up" })).status).toBe(404);
      expect((await as(p).get(`/v1/threads/${x.threadId}/feedback`)).status).toBe(404);
    }
    expect(
      (await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" })).status,
    ).toBe(200);
    expect((await rate(x.author, x.runId, { rating: "up" })).status).toBe(200);
    const theirs = await rate(x.reader, x.runId, {
      rating: "down",
      reasons: ["other"],
      comment: "reader's own note",
    });
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(200);
    // Each sees only their own rating.
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toMatchObject({ rating: "up" });
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toMatchObject({
      rating: "down",
      comment: "reader's own note",
    });
    expect((await mine(outsider, x.threadId)).answers[0]?.feedback).toBeNull();
    // Clearing touches the caller's row only.
    expect((await clear(outsider, x.runId)).status).toBe(204);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).not.toBeNull();

    // The share ends: the reader can't read or rate any more, but can still take theirs back.
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "private" });
    expect((await rate(x.reader, x.runId, { rating: "up" })).status).toBe(404);
    expect((await clear(x.reader, x.runId)).status).toBe(204);
    const left = await f.fx.admin.query(`SELECT user_id FROM answer_feedback WHERE team_id = $1`, [
      x.w.team,
    ]);
    expect(left.rows).toEqual([{ user_id: x.author.id }]);
  });

  it("lets a project-share reader rate, and nobody outside the workspace", async () => {
    const x = await world();
    // Every workspace member reads every project (KOBE-587): an outsider is in another workspace.
    const outsider = (await f.world()).owner;
    const project = await as(x.w.owner).post("/v1/projects", {
      name: `P ${randomUUID().slice(0, 6)}`,
      member_user_ids: [x.author.id, x.reader.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const moved = await as(x.author).post(`/v1/threads/${x.threadId}/move`, {
      project_id: project.json.id,
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect((await rate(x.reader, x.runId, { rating: "up" })).status).toBe(404);
    const shared = await as(x.author).post(`/v1/threads/${x.threadId}/share`, {
      visibility: "project",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect((await rate(x.reader, x.runId, { rating: "up" })).status).toBe(200);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toMatchObject({ rating: "up" });
    expect((await rate(outsider, x.runId, { rating: "up" })).status).toBe(404);
    expect((await as(outsider).get(`/v1/threads/${x.threadId}/feedback`)).status).toBe(404);
  });

  it("never reaches another team's run", async () => {
    const x = await world();
    const y = await world();
    expect((await rate(x.author, y.runId, { rating: "up" })).status).toBe(404);
    expect((await as(x.author).get(`/v1/threads/${y.threadId}/feedback`)).status).toBe(404);
    expect((await clear(x.author, y.runId)).status).toBe(204);
  });

  it("takes no ratings in Trash and lists no answers there", async () => {
    const x = await world();
    expect((await as(x.author).delete(`/v1/threads/${x.threadId}`)).status).toBe(200);
    const res = await rate(x.author, x.runId, { rating: "up" });
    expect(res.json.code).toBe("thread_in_trash");
    expect((await mine(x.author, x.threadId)).answers).toEqual([]);
  });
});

describe("Langfuse scores (ac-5)", () => {
  it("exports a score on the run's trace with ids and reasons, no comment, and deletes it on clear", async () => {
    const x = await world();
    sink.calls.length = 0;
    await rate(x.author, x.runId, {
      rating: "down",
      reasons: ["unsafe"],
      comment: "do not export",
    });
    const upserts = (await scores()).filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(1);
    const score = (upserts[0] as { score: TraceScore }).score;
    expect(score).toMatchObject({
      traceId: runTraceId(x.runId),
      name: "answer_feedback",
      dataType: "BOOLEAN",
      value: 0,
      metadata: {
        rating: "down",
        reasons: ["unsafe"],
        team_id: x.w.team,
        thread_id: x.threadId,
        run_id: x.runId,
        agent_scope: "team",
        agent_id: x.agentId,
        agent_version: 1,
      },
    });
    expect(JSON.stringify(score)).not.toContain("do not export");
    expect(score).not.toHaveProperty("comment");

    await rate(x.author, x.runId, { rating: "up" });
    await clear(x.author, x.runId);
    const calls = await scores();
    expect(calls.at(-1)).toEqual({ op: "remove", id: score.id });
    const ids = new Set(calls.map((c) => (c.op === "upsert" ? c.score.id : c.id)));
    expect(ids).toEqual(new Set([score.id]));
  });
});

describe("score export queue", () => {
  it("coalesces changes to one rating, survives a failing backend and drops past its bound", async () => {
    const x = await world();
    const second = await x.answer("second");
    await rate(x.author, x.runId, { rating: "up" });
    await rate(x.author, second.runId, { rating: "down" });
    const ids = (
      await f.fx.admin.query<{ id: string; run_id: string }>(
        `SELECT id, run_id FROM answer_feedback WHERE team_id = $1 ORDER BY run_id = $2 DESC`,
        [x.w.team, x.runId],
      )
    ).rows.map((r) => r.id);
    const [first, other] = ids as [string, string];
    const seen: string[] = [];
    let fail = true;
    const queue = new FeedbackScores({
      db: f.fx.db,
      captureContent: true,
      maxPending: 1,
      sink: {
        upsert: (score) => {
          seen.push(score.id);
          if (fail) {
            fail = false;
            return Promise.reject(new Error("backend down"));
          }
          return Promise.resolve();
        },
        remove: (id) => {
          seen.push(`-${id}`);
          return Promise.resolve();
        },
      },
    });
    // The first call fails (logged, dropped), and the queue goes on.
    queue.enqueue(x.w.team, first);
    await queue.idle();
    // A burst on one rating: one call in flight, the rest coalesce into one pending call; a second
    // rating while one is pending is over the bound of 1 and dropped.
    queue.enqueue(x.w.team, first);
    queue.enqueue(x.w.team, first);
    queue.enqueue(x.w.team, first);
    queue.enqueue(x.w.team, other);
    await queue.idle();
    expect(seen).toEqual([first, first, first]);
    // A rating that is gone is removed by its id.
    queue.enqueue(x.w.team, randomUUID());
    await queue.idle();
    expect(seen.at(-1)).toMatch(/^-/);
  });
});
