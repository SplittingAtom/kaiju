import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sql } from "@kobe/db";
import { MEMORY_PASS_MAX_MS } from "@kobe/protocol";
import { AppendError, appendRunEvents } from "../event-stream/append.js";
import { LEARN_PASSES_PER_DAY } from "./learn/passes.js";
import { type LearningPasses } from "./learn/run.js";
import { delta } from "../testing/event-stream-fixture.js";
import {
  fx,
  owner,
  mate,
  team,
  LEARNER,
  gateway,
  background,
  passes,
  passesOn,
  holdThread,
  latch,
  heldReply,
  siteLearner,
  msg,
  seedThread,
  addEntries,
  completedRun,
  viewer,
  candidate,
  reply,
  passRow,
  candidatesOf,
  watermarkOf,
  passEvents,
  passAudits,
  startAndWait,
  useMemoryLearnPassWorld,
} from "./memory-learn-pass.test-helpers.js";

useMemoryLearnPassWorld();

describe("start refusals (ac-2)", () => {
  it("refuses with no learning model or one the Workspace has not enabled: no fallback", async () => {
    const s = await seedThread("I prefer metric units.");
    await siteLearner(null);
    try {
      expect(await passes.start(viewer(), s.threadId)).toMatchObject({
        ok: false,
        code: "memory_learning_model_unavailable",
        reason: "no_learning_model",
      });
      await siteLearner(`${LEARNER}-off`);
      expect(await passes.start(viewer(), s.threadId)).toMatchObject({
        ok: false,
        code: "memory_learning_model_unavailable",
        reason: "learning_model_not_enabled",
      });
    } finally {
      await siteLearner(LEARNER);
    }
    expect(gateway.calls).toHaveLength(0);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM memory_learning_passes WHERE thread_id = $1`,
      [s.threadId],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses when Learn is switched off for the Workspace", async () => {
    const s = await seedThread("I prefer metric units.");
    await fx.admin.query(
      `UPDATE teams SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('memory', $2::jsonb)
        WHERE id = $1`,
      [team, JSON.stringify({ learn_enabled: false })],
    );
    try {
      expect(await passes.start(viewer(), s.threadId)).toMatchObject({
        ok: false,
        code: "memory_disabled",
        reason: "learn_off",
      });
    } finally {
      await fx.admin.query(`UPDATE teams SET settings = settings - 'memory' WHERE id = $1`, [team]);
    }
  });

  it(`refuses the ${LEARN_PASSES_PER_DAY + 1}st pass of a day`, async () => {
    const s = await seedThread("I prefer metric units.");
    await fx.admin.query(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status,
          error, started_at, finished_at)
       SELECT $1, $2, $3, 'a1', 'm', 'v1', 'failed', 'x', now(), now() FROM generate_series(1, $4)`,
      [team, s.threadId, mate.id, LEARN_PASSES_PER_DAY],
    );
    const ms = await seedThread("I prefer metric units.", mate);
    expect(await passes.start(viewer(mate), ms.threadId)).toMatchObject({
      ok: false,
      code: "learn_rate_limited",
    });
    // Per person: the owner still may.
    expect(await startAndWait(s)).toMatchObject({ ok: true });
  });

  it("two replicas cannot go past the daily count together (KOBE-787)", async () => {
    // One person, one pass left today, two threads started at once on two replicas: the second
    // start must wait for the first one's claim (per-person lock), then count it.
    const who = await fx.person(`pd${randomBytes(2).toString("hex")}`);
    await fx.addMember(team, who);
    const a = await seedThread("I prefer metric units.", who);
    const b = await seedThread("I prefer short answers.", who);
    await fx.admin.query(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status,
          error, started_at, finished_at)
       SELECT $1, $2, $3, 'a1', 'm', 'v1', 'failed', 'x', now(), now() FROM generate_series(1, $4)`,
      [team, a.threadId, who.id, LEARN_PASSES_PER_DAY - 1],
    );
    let second: Promise<Awaited<ReturnType<LearningPasses["start"]>>> | undefined;
    const first = await passesOn(0, async (tx) => {
      const pid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]
        ?.pid;
      let settled = false;
      second = passesOn(1).start(viewer(who), b.threadId);
      void second.finally(() => (settled = true));
      // The other start either finished (no lock: it counted without this claim) or waits on us.
      await vi.waitFor(
        async () => {
          const { rows } = await fx.admin.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid)))
               AS blocked`,
            [pid],
          );
          expect(settled || rows[0]?.blocked).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
    }).start(viewer(who), a.threadId);
    expect(first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false, code: "learn_rate_limited" });
    await background.idle();
  });

  it("refuses at 100 % of a budget line", async () => {
    const who = await fx.person(`pb${randomBytes(2).toString("hex")}`);
    await fx.addMember(team, who);
    const s = await seedThread("I prefer metric units.", who);
    // A $0 line is used up at no spend (spend >= limit).
    await fx.admin.query(
      `INSERT INTO team_budgets (team_id, user_id, monthly_usd, updated_by) VALUES ($1, $2, 0, $3)`,
      [team, who.id, owner.id],
    );
    expect(await passes.start(viewer(who), s.threadId)).toMatchObject({
      ok: false,
      code: "budget_exhausted",
    });
    expect(gateway.calls).toHaveLength(0);
  });

  it("binds only a completed run on the visible branch, leased to the author", async () => {
    const threadId = randomUUID();
    await fx.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
      team,
      threadId,
      owner.id,
    ]);
    // u1 → a1 (a completed run) and u1 → b1 (the leaf, no run of its own on the branch).
    await addEntries(threadId, [
      ["u1", null, msg("user", "I prefer metric units.")],
      ["a1", "u1", msg("assistant", "Noted.")],
      ["x2", "a1", msg("user", "Other branch.")],
    ]);
    await completedRun(threadId, "x2");
    await fx.admin.query(`UPDATE threads SET leaf_entry_id = 'a1' WHERE team_id = $1 AND id = $2`, [
      team,
      threadId,
    ]);
    expect(await passes.start(viewer(), threadId)).toMatchObject({
      ok: false,
      code: "no_completed_run",
    });
    const onBranch = await completedRun(threadId, "u1");
    expect(await startAndWait({ threadId, runId: onBranch })).toMatchObject({
      ok: true,
      runId: onBranch,
    });
  });

  it("refuses someone who is not the thread's author", async () => {
    const s = await seedThread("I prefer metric units.");
    expect(await passes.start(viewer(mate), s.threadId)).toMatchObject({
      ok: false,
      code: "thread_not_found",
    });
  });
});

describe("one pass per thread, across replicas (ac-3)", () => {
  it("a running pass written by another replica refuses a new one", async () => {
    const s = await seedThread("I prefer metric units.");
    await fx.admin.query(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status, started_at)
       VALUES ($1, $2, $3, 'a1', 'm', 'v1', 'running', now())`,
      [team, s.threadId, owner.id],
    );
    expect(await passesOn(1).start(viewer(), s.threadId)).toMatchObject({
      ok: false,
      code: "pass_running",
    });
    expect(gateway.calls).toHaveLength(0);
  });

  it("two replicas starting at once: the database lets exactly one through", async () => {
    // KOBE-770: the winner's pass is held in its model call, so it is still running when the
    // other start claims: the overlap is real, not a pass that already finished.
    const s = await seedThread("I prefer metric units.");
    const held = latch();
    gateway.replies = [heldReply(held)];
    const results = await Promise.all([
      passesOn(0).start(viewer(), s.threadId),
      passesOn(1).start(viewer(), s.threadId),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "pass_running" });
    held.open();
    await background.idle();
    expect(gateway.calls).toHaveLength(1);
  });

  it("a start after the pass finished has nothing new to learn", async () => {
    const s = await seedThread("I prefer metric units.");
    expect(await passesOn(0).start(viewer(), s.threadId)).toMatchObject({ ok: true });
    await background.idle();
    expect(await passesOn(1).start(viewer(), s.threadId)).toMatchObject({
      ok: false,
      code: "nothing_to_learn",
    });
    expect(gateway.calls).toHaveLength(1);
  });

  it("a pass that finishes while another replica's start is checking cannot let it learn the same messages", async () => {
    // KOBE-770: the second start has read the old watermark and is about to claim when the first
    // pass's model call returns. Its completion must wait for the start (thread lock), so the
    // claim still meets the running row; otherwise both passes learn u1..a1.
    const s = await seedThread("I prefer metric units.");
    const held = latch();
    gateway.replies = [heldReply(held)];
    const first = await passesOn(0).start(viewer(), s.threadId);
    if (!first.ok) throw new Error(`first start refused: ${first.code}`);
    const second = await passesOn(1, async (tx) => {
      const pid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]
        ?.pid;
      held.open();
      // The first pass either completes (its row leaves `running`) or waits behind this start.
      await vi.waitFor(
        async () => {
          const { rows } = await fx.admin.query<{ status: string; blocked: boolean }>(
            `SELECT (SELECT status FROM memory_learning_passes WHERE id = $1) AS status,
                    EXISTS (SELECT 1 FROM pg_stat_activity WHERE $2 = ANY (pg_blocking_pids(pid)))
                      AS blocked`,
            [first.passId, pid],
          );
          expect(rows[0]?.status !== "running" || rows[0]?.blocked).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
    }).start(viewer(), s.threadId);
    expect(second).toMatchObject({ ok: false, code: "pass_running" });
    await background.idle();
    expect(await passRow(first.passId)).toMatchObject({ status: "completed" });
    const { rows } = await fx.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM memory_learning_passes WHERE team_id = $1 AND thread_id = $2`,
      [team, s.threadId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(gateway.calls).toHaveLength(1);
  });

  it("a pass left running by a stopped server is failed (Retry) and frees the thread", async () => {
    const s = await seedThread("I prefer metric units.");
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status, started_at)
       VALUES ($1, $2, $3, 'a1', 'm', 'v1', 'running', now() - make_interval(secs => $4))
       RETURNING id`,
      [team, s.threadId, owner.id, MEMORY_PASS_MAX_MS / 1000 + 5],
    );
    expect(await passes.sweep()).toBeGreaterThanOrEqual(1);
    expect(await passRow(rows[0]?.id ?? "")).toMatchObject({ status: "failed" });
    expect(await passAudits(rows[0]?.id ?? "")).toMatchObject([
      {
        action: "memory.pass.failed",
        team_id: team,
        actor_kind: "system",
        actor_id: null,
        target: { threadId: s.threadId, reason: "interrupted", attempts: 0 },
      },
    ]);
    expect(await startAndWait(s)).toMatchObject({ ok: true });
  });
});

describe("completion behind a busy thread (KOBE-770 review)", () => {
  it("retries the completion when the thread lock times out, and completes once it is free", async () => {
    // A statement of its own: earlier tests saved "metric units" for this person (a known one).
    const said = `My build host is called h${randomBytes(3).toString("hex")}.`;
    const s = await seedThread(said);
    // The model call is held until the thread is locked: the start itself takes that lock.
    const answered = latch();
    gateway.replies = [
      async () => {
        await answered.opened;
        return reply(
          candidate({ statement: said, evidence: [{ entry_id: "u1", quote: said.slice(0, -1) }] }),
        );
      },
    ];
    const retries: number[] = [];
    let release: () => Promise<void> = async () => undefined;
    try {
      const started = await passesOn(0, undefined, {
        lockTimeoutMs: 100,
        retryDelaysMs: [0, 0],
        beforeRetry: async (attempt) => {
          retries.push(attempt);
          await release();
        },
      }).start(viewer(), s.threadId);
      if (!started.ok) throw new Error(`refused: ${started.code}`);
      release = await holdThread(s.threadId);
      answered.open();
      await background.idle();
      expect(retries).toEqual([1]);
      expect(await passRow(started.passId)).toMatchObject({ status: "completed" });
      expect(await candidatesOf(started.passId)).toHaveLength(1);
      expect(await watermarkOf(s.threadId)).toBe("a1");
      expect(gateway.calls).toHaveLength(1); // the model result was reused, not asked again
    } finally {
      await release();
    }
  });

  it("fails as thread_busy (not model_error) when the thread stays locked, the watermark kept", async () => {
    // A statement of its own: earlier tests saved "metric units" for this person (a known one).
    const said = `My build host is called h${randomBytes(3).toString("hex")}.`;
    const s = await seedThread(said);
    // The model call is held until the thread is locked: the start itself takes that lock.
    const answered = latch();
    gateway.replies = [
      async () => {
        await answered.opened;
        return reply(
          candidate({ statement: said, evidence: [{ entry_id: "u1", quote: said.slice(0, -1) }] }),
        );
      },
    ];
    const retries: number[] = [];
    let release: () => Promise<void> = async () => undefined;
    try {
      const started = await passesOn(0, undefined, {
        lockTimeoutMs: 100,
        retryDelaysMs: [0, 0],
        beforeRetry: async (attempt) => {
          retries.push(attempt);
        },
      }).start(viewer(), s.threadId);
      if (!started.ok) throw new Error(`refused: ${started.code}`);
      release = await holdThread(s.threadId);
      answered.open();
      await background.idle();
      expect(retries).toEqual([1, 2]);
      const row = await passRow(started.passId);
      expect(row).toMatchObject({ status: "failed" });
      expect(row?.error).toMatch(/^thread_busy: lock_timeout/);
      expect(await candidatesOf(started.passId)).toHaveLength(0);
      expect(await watermarkOf(s.threadId)).toBeNull();
      expect((await passEvents(s.runId)).at(-1)).toMatchObject({
        type: "memory.pass.failed",
        payload: { code: "thread_busy", retryable: true },
      });
      expect((await passAudits(started.passId)).at(-1)).toMatchObject({
        action: "memory.pass.failed",
        target: { reason: "thread_busy" },
      });
    } finally {
      await release();
    }
  });
});

describe("the append guard for pass events", () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: unknown) => (e instanceof AppendError ? e.code : String(e)),
    );

  async function runningPass(threadId: string, agoSeconds = 0) {
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status, started_at)
       VALUES ($1, $2, $3, 'a1', 'm', 'v1', 'running', now() - make_interval(secs => $4)) RETURNING id`,
      [team, threadId, owner.id, agoSeconds],
    );
    return rows[0]?.id ?? "";
  }
  const progress = (passId: string, threadId: string) => ({
    type: "memory.pass.progress",
    payload: { pass_id: passId, thread_id: threadId, stage: "reading" },
  });
  const done = (passId: string, threadId: string) => ({
    type: "memory.pass.completed",
    payload: { pass_id: passId, thread_id: threadId, candidates: 0, dropped: 0, skill_hints: 0 },
  });

  it("takes events of a running pass on an ended run of its thread, and ends it once", async () => {
    const s = await seedThread("hello");
    const passId = await runningPass(s.threadId);
    expect(await code(appendRunEvents(fx.db, team, s.runId, [progress(passId, s.threadId)]))).toBe(
      "ok",
    );
    expect(
      await code(
        appendRunEvents(fx.db, team, s.runId, [
          done(passId, s.threadId),
          progress(passId, s.threadId),
        ]),
      ),
    ).toBe("pass_refused");
    // After pass events the run is still ended for everything else.
    expect(await code(appendRunEvents(fx.db, team, s.runId, [delta("late")]))).toBe("run_finished");
  });

  it("refuses a closed, stale, unknown or other thread's pass, a live run, and mixed batches", async () => {
    const s = await seedThread("hello");
    const other = await seedThread("hello");
    const stale = await runningPass(s.threadId, MEMORY_PASS_MAX_MS / 1000 + 5);
    expect(await code(appendRunEvents(fx.db, team, s.runId, [progress(stale, s.threadId)]))).toBe(
      "pass_refused",
    );
    await fx.admin.query(
      `UPDATE memory_learning_passes SET status = 'failed', error = 'x', finished_at = now() WHERE id = $1`,
      [stale],
    );
    const passId = await runningPass(s.threadId);
    expect(
      await code(appendRunEvents(fx.db, team, other.runId, [progress(passId, s.threadId)])),
    ).toBe("pass_refused");
    expect(
      await code(appendRunEvents(fx.db, team, s.runId, [progress(randomUUID(), s.threadId)])),
    ).toBe("pass_refused");
    expect(
      await code(appendRunEvents(fx.db, team, s.runId, [progress(passId, s.threadId), delta("x")])),
    ).toBe("pass_refused");
    const live = await fx.run(team, owner);
    expect(await code(appendRunEvents(fx.db, team, live, [progress(passId, s.threadId)]))).toBe(
      "pass_refused",
    );
    await fx.admin.query(
      `UPDATE memory_learning_passes SET status = 'completed', to_entry_id = 'a1', finished_at = now() WHERE id = $1`,
      [passId],
    );
    expect(await code(appendRunEvents(fx.db, team, s.runId, [progress(passId, s.threadId)]))).toBe(
      "pass_refused",
    );
  });
});
