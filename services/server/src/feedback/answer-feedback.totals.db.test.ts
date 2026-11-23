import { strFromU8, unzipSync } from "fflate";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { seedGalleryAgents } from "../gallery/seed.js";
import { runRetentionPass } from "../retention/index.js";
import type { Person } from "../testing/event-stream-fixture.js";
import {
  GALLERY,
  f,
  as,
  publishedAgent,
  world,
  rate,
  clear,
  mine,
  placeHold,
  releaseHold,
  seedRatings,
  totals,
  WITHHELD,
  useAnswerFeedbackFixture,
} from "./answer-feedback.test-helpers.js";

useAnswerFeedbackFixture();

describe("totals for agent owners (ac-3)", () => {
  it("counts per version, model, reason and day over at least five other raters, with no content", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await rate(x.author, x.runId, { rating: "down", reasons: ["wrong"], comment: "SECRET-1" });
    await rate(x.reader, x.runId, { rating: "down", reasons: ["wrong"], comment: "SECRET-2" });
    // Rated yesterday (today's ratings count once the day is over).
    await f.fx.admin.query(
      `UPDATE answer_feedback SET created_at = created_at - interval '1 day',
         updated_at = updated_at - interval '1 day' WHERE team_id = $1`,
      [x.w.team],
    );
    // Two raters: below the minimum, nothing but "not enough" shows.
    expect((await totals(x.w.owner, x.agentId)).json).toMatchObject({
      bucket: "day",
      min_raters: 5,
      totals: WITHHELD,
      versions: null,
      series: null,
    });

    const agent = { scope: "team", id: x.agentId, version: 1 };
    await seedRatings(x.w.team, agent, 5, { rating: "down", reasons: ["wrong"], model: "fast" });
    await seedRatings(x.w.team, agent, 5, { rating: "up", model: "smart" });
    const res = await totals(x.w.owner, x.agentId);
    expect(res.json).toMatchObject({
      totals: { enough: true, up: 5, down: 7, rate: 5 / 12 },
      versions: [
        {
          version: 1,
          up: 5,
          down: 7,
          reasons: { wrong: 7, unsafe: 0, too_slow: 0, ignored_instructions: 0, other: 0 },
          // The two real ratings (model unknown) are under five raters: no model breakdown.
          models: null,
        },
      ],
    });
    expect(res.json.series).toEqual([
      { start: expect.stringMatching(/T00:00:00\.000Z$/), up: 5, down: 7 },
    ]);
    for (const secret of ["SECRET", x.threadId, x.runId, x.author.id, x.reader.id]) {
      expect(res.text).not.toContain(secret);
    }
  });

  it("hides a whole breakdown when any of its cells is under five raters (no differencing)", async () => {
    const x = await world();
    const agent = { scope: "team", id: x.agentId, version: 1 };
    await seedRatings(x.w.team, agent, 5, { rating: "up", model: "smart", daysAgo: 2 });
    await seedRatings(x.w.team, agent, 5, { rating: "down", reasons: ["wrong"], model: "smart" });
    // One lone rater: another model, another reason, another day, another version.
    await seedRatings(x.w.team, { ...agent, version: 2 }, 1, {
      rating: "down",
      reasons: ["unsafe"],
      model: "fast",
      daysAgo: 3,
    });
    const res = (await totals(x.w.owner, x.agentId)).json;
    // The totals stand (11 raters), but no breakdown could leave the lone rating as a remainder.
    expect(res.totals).toEqual({ enough: true, up: 5, down: 6, rate: 5 / 11 });
    expect(res.versions).toBeNull();
    expect(res.series).toBeNull();
    // Without the lone rater's version and day, the version's own breakdowns still hide it.
    const y = await world();
    const solo = { scope: "team", id: y.agentId, version: 1 };
    await seedRatings(y.w.team, solo, 5, { rating: "down", reasons: ["wrong"], model: "smart" });
    await seedRatings(y.w.team, solo, 1, { rating: "down", reasons: ["unsafe"], model: "fast" });
    const one = (await totals(y.w.owner, y.agentId)).json;
    expect(one.totals).toMatchObject({ enough: true, down: 6 });
    expect(one.series).toEqual([{ start: expect.any(String), up: 0, down: 6 }]);
    expect(one.versions).toEqual([
      { version: 1, up: 0, down: 6, rate: 0, reasons: null, models: null },
    ]);
  });

  it("takes only the preset windows of finished days, so a new rating today reveals nothing", async () => {
    const x = await world();
    const agent = { scope: "team", id: x.agentId, version: 1 };
    await seedRatings(x.w.team, agent, 6, { rating: "up", daysAgo: 2 });
    await seedRatings(x.w.team, agent, 5, { rating: "down", daysAgo: 20 });
    const week = (await totals(x.w.owner, x.agentId, "?window=7")).json;
    expect(week).toMatchObject({ window_days: 7, totals: { enough: true, up: 6, down: 0 } });
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe(7 * 86_400_000);
    expect(week.to).toMatch(/T00:00:00\.000Z$/);
    const month = (await totals(x.w.owner, x.agentId)).json;
    expect(month).toMatchObject({ window_days: 30, totals: { up: 6, down: 5 } });
    expect((await totals(x.w.owner, x.agentId, "?window=90")).json.totals).toEqual(month.totals);
    // Today's ratings don't count until the day is over.
    await seedRatings(x.w.team, agent, 1, { rating: "down", daysAgo: 0 });
    expect((await totals(x.w.owner, x.agentId)).json).toEqual(month);
    // No custom ranges, buckets or other windows.
    for (const q of [
      "?window=14",
      "?window=7&window=30",
      `?from=${new Date(Date.now() - 3 * 86_400_000).toISOString()}`,
      `?to=${new Date().toISOString()}`,
      "?bucket=day",
      "?window=30&from=2026-01-01T00:00:00Z",
    ]) {
      expect((await as(x.w.owner).get(`/v1/agents/${x.agentId}/feedback${q}`)).status, q).toBe(400);
    }
  });

  it("doesn't count the caller among the raters, and shows a one-rater agent nothing", async () => {
    const x = await world();
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, x.reader.id],
    );
    const own = await publishedAgent(x.reader);
    const agent = { scope: "team", id: own, version: 1 };
    // One other rater: withheld.
    await seedRatings(x.w.team, agent, 1, { rating: "down", reasons: ["unsafe"] });
    expect((await totals(x.reader, own)).json).toMatchObject({
      totals: WITHHELD,
      versions: null,
      series: null,
    });
    // Four others plus the owner's own rating: still four other raters.
    await seedRatings(x.w.team, agent, 3, { rating: "up" });
    const [mine] = await seedRatings(x.w.team, agent, 1, { rating: "up" });
    await f.fx.admin.query(
      `UPDATE answer_feedback SET user_id = $1 WHERE team_id = $2 AND user_id = $3`,
      [x.reader.id, x.w.team, mine],
    );
    expect((await totals(x.reader, own)).json.totals).toEqual(WITHHELD);
    // A fifth other rater: shown, the owner's own rating included in the numbers.
    await seedRatings(x.w.team, agent, 1, { rating: "up" });
    expect((await totals(x.reader, own)).json.totals).toEqual({
      enough: true,
      up: 5,
      down: 1,
      rate: 5 / 6,
    });
    expect((await totals(x.w.owner, own)).json.totals).toMatchObject({ enough: true, up: 5 });
  });

  it("is for owners and team admins: members, other builders and other teams are refused", async () => {
    const x = await world();
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
      [x.w.team, x.reader.id],
    );
    expect((await as(x.author).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(403);
    expect((await as(x.reader).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(403);
    expect((await as(x.w.owner).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(200);
    const other = await f.world();
    expect((await as(other.owner).get(`/v1/agents/${x.agentId}/feedback`)).status).toBe(404);
  });

  it("shows a personal agent's totals to its owner only, never to a team admin", async () => {
    const x = await world();
    const created = await as(x.author).post("/v1/agents", {
      scope: "personal",
      frontmatter: { name: "Mine" },
      prompt: "Mine.",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.agent.id as string;
    await seedRatings(x.w.team, { scope: "personal", id, version: null }, 5, { rating: "up" });
    expect((await totals(x.author, id)).json.totals).toMatchObject({ enough: true, up: 5 });
    // To the team admin someone else's personal agent doesn't exist.
    expect((await as(x.w.owner).get(`/v1/agents/${id}/feedback`)).status).toBe(404);
  });

  it("confines a gallery agent's totals to the active team, for its team admins", async () => {
    await seedGalleryAgents(f.fx.db, [GALLERY]);
    const x = await world();
    const y = await world();
    const list = await as(x.w.owner).get("/v1/agents?scope=gallery");
    const id = (list.json.agents as { id: string; slug: string }[]).find(
      (a) => a.slug === GALLERY.key,
    )?.id as string;
    expect(id).toBeDefined();
    const agent = { scope: "gallery", id, version: 1 };
    await seedRatings(x.w.team, agent, 5, { rating: "up" });
    await seedRatings(y.w.team, agent, 7, { rating: "down" });
    expect((await totals(x.w.owner, id)).json.totals).toMatchObject({ up: 5, down: 0 });
    expect((await totals(y.w.owner, id)).json.totals).toMatchObject({ up: 0, down: 7 });
    expect((await as(x.author).get(`/v1/agents/${id}/feedback`)).status).toBe(403);
  });
});

describe("ratings follow their thread (ac-4)", () => {
  it("are purged with the thread from Trash; a hold keeps them, silently", async () => {
    const x = await world();
    const y = await world();
    await rate(x.author, x.runId, { rating: "down", comment: "held note" });
    await rate(y.author, y.runId, { rating: "down", comment: "free note" });
    await placeHold(x.w.team, x.author.id);
    // Held and unheld members get the very same answers.
    const shape = (res: { status: number; json: unknown }) => {
      const body = res.json as Record<string, unknown> | null;
      return {
        status: res.status,
        body: body && { ...body, run_id: "-", thread_id: "-", entry_id: "-", updated_at: "-" },
      };
    };
    for (const body of [{ rating: "up" }, { rating: "down", reasons: ["other"] }]) {
      expect(shape(await rate(x.author, x.runId, body))).toEqual(
        shape(await rate(y.author, y.runId, body)),
      );
    }
    const cleared = [await clear(x.author, x.runId), await clear(y.author, y.runId)];
    expect(cleared.map((r) => [r.status, r.text])).toEqual([
      [204, ""],
      [204, ""],
    ]);
    expect((await mine(x.author, x.threadId)).answers[0]?.feedback).toBeNull();
    // The held member's earlier values are kept; the unheld one's are not.
    const kept = await f.fx.admin.query<{
      team_id: string;
      comment: string | null;
      change: string;
    }>(
      `SELECT team_id, comment, change FROM answer_feedback_history
        WHERE team_id = ANY($1::uuid[]) ORDER BY kept_at, change`,
      [[x.w.team, y.w.team]],
    );
    expect(kept.rows).toEqual([
      { team_id: x.w.team, comment: "held note", change: "changed" },
      { team_id: x.w.team, comment: null, change: "changed" },
      { team_id: x.w.team, comment: null, change: "cleared" },
    ]);
    for (const t of [x, y]) {
      expect((await as(t.author).delete(`/v1/threads/${t.threadId}`)).status).toBe(200);
      await f.fx.admin.query(
        `UPDATE threads SET deleted_at = now() - interval '31 days' WHERE team_id = $1 AND id = $2`,
        [t.w.team, t.threadId],
      );
    }
    await runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    const threadsLeft = await f.fx.admin.query<{ team_id: string }>(
      `SELECT team_id FROM threads WHERE id = ANY($1::uuid[])`,
      [[x.threadId, y.threadId]],
    );
    expect(threadsLeft.rows).toEqual([{ team_id: x.w.team }]);
    const historyLeft = await f.fx.admin.query(
      `SELECT 1 FROM answer_feedback_history WHERE team_id = $1`,
      [x.w.team],
    );
    expect(historyLeft.rowCount).toBe(3);
  });

  it("answer a reader on a held owner's thread exactly as on an unheld one", async () => {
    const x = await world();
    const y = await world();
    for (const t of [x, y]) {
      await as(t.author).post(`/v1/threads/${t.threadId}/share`, { visibility: "team" });
      await rate(t.reader, t.runId, { rating: "down", comment: "reader note" });
    }
    await placeHold(x.w.team, x.author.id);
    const shape = (res: { status: number; json: unknown; text: string }) => {
      const body = res.json as Record<string, unknown> | null;
      return {
        status: res.status,
        body: body && { ...body, run_id: "-", thread_id: "-", entry_id: "-", updated_at: "-" },
        text: body ? undefined : res.text,
      };
    };
    for (const body of [
      { rating: "up" },
      { rating: "up" },
      { rating: "down", reasons: ["other"] },
    ]) {
      expect(shape(await rate(x.reader, x.runId, body))).toEqual(
        shape(await rate(y.reader, y.runId, body)),
      );
    }
    expect(shape(await clear(x.reader, x.runId))).toEqual(shape(await clear(y.reader, y.runId)));
    expect(shape(await as(x.reader).get(`/v1/threads/${x.threadId}/feedback`)).status).toBe(200);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toBeNull();
    // The held thread's evidence is kept: the first comment, the later reason, the clear.
    const kept = await f.fx.admin.query<{ comment: string | null; change: string }>(
      `SELECT comment, change FROM answer_feedback_history WHERE team_id = $1 ORDER BY kept_at, change`,
      [x.w.team],
    );
    expect(kept.rows).toEqual([
      { comment: "reader note", change: "changed" },
      { comment: null, change: "changed" },
      { comment: null, change: "cleared" },
    ]);
  });

  it("keep a held reader's own comment on someone else's thread, silently", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await rate(x.reader, x.runId, { rating: "down", comment: "reader's note" });
    await placeHold(x.w.team, x.reader.id);
    expect((await clear(x.reader, x.runId)).status).toBe(204);
    expect((await mine(x.reader, x.threadId)).answers[0]?.feedback).toBeNull();
    const kept = await f.fx.admin.query(
      `SELECT user_id, comment FROM answer_feedback_history WHERE team_id = $1`,
      [x.w.team],
    );
    expect(kept.rows).toEqual([{ user_id: x.reader.id, comment: "reader's note" }]);
  });

  it("purge what a hold kept once the hold is released", async () => {
    const x = await world();
    await rate(x.author, x.runId, { rating: "down", comment: "kept for the matter" });
    const hold = await placeHold(x.w.team, x.author.id);
    expect((await clear(x.author, x.runId)).status).toBe(204);
    const kept = () =>
      f.fx.admin.query(`SELECT 1 FROM answer_feedback_history WHERE team_id = $1`, [x.w.team]);
    const pass = () => runRetentionPass({ db: f.fx.db, logger: pino({ level: "silent" }) });
    // Still held: the pass keeps it.
    await pass();
    expect((await kept()).rowCount).toBe(1);
    await releaseHold(hold);
    const result = await pass();
    expect(result.teams.find((t) => t.teamId === x.w.team)).toMatchObject({
      feedbackHistory: { rows: 1 },
      failed: false,
    });
    expect((await kept()).rowCount).toBe(0);
    const audited = await f.fx.admin.query<{ target: unknown }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'retention.feedback_history_purged'`,
      [x.w.team],
    );
    expect(audited.rows).toEqual([{ target: { rows: 1 } }]);
  });

  it("are in the member's export with their comment, their own only", async () => {
    const x = await world();
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "team" });
    await rate(x.author, x.runId, { rating: "down", reasons: ["wrong"], comment: "author note" });
    await rate(x.reader, x.runId, { rating: "down", comment: "reader note" });
    const exported = async (p: Person) => {
      const res = await as(p).get("/v1/threads/export");
      expect(res.status).toBe(200);
      const files = unzipSync(res.bytes);
      return JSON.parse(strFromU8(files["feedback.json"] ?? new Uint8Array())) as {
        feedback: Record<string, unknown>[];
      };
    };
    expect((await exported(x.author)).feedback).toEqual([
      expect.objectContaining({
        run_id: x.runId,
        rating: "down",
        reasons: ["wrong"],
        comment: "author note",
      }),
    ]);
    // The reader's export holds their rating of the shared answer, not the author's.
    expect((await exported(x.reader)).feedback).toEqual([
      expect.objectContaining({ thread_id: x.threadId, comment: "reader note" }),
    ]);
  });
});
