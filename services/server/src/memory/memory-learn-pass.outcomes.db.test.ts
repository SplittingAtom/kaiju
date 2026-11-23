import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySpanExporter, initTelemetry } from "@kobe/telemetry";
import { BackgroundTasks } from "../background.js";
import { ServerCallError, type ServerCallInput } from "../models/gateway-client.js";
import { CURRENT_EXTRACTOR_PROMPT } from "./learn/prompt/index.js";
import { createLearningPasses } from "./learn/run.js";
import { statementHash } from "./learn/validate.js";
import {
  fx,
  owner,
  team,
  LEARNER,
  NO_LOG,
  gateway,
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
  expectNoContent,
  startAndWait,
  useMemoryLearnPassWorld,
} from "./memory-learn-pass.test-helpers.js";

useMemoryLearnPassWorld();

describe("a pass that succeeds (ac-4)", () => {
  it("stores screened candidates, moves the watermark and streams its events to the run", async () => {
    const s = await seedThread("I prefer metric units. My manager is Dana.");
    gateway.replies = [
      reply(
        candidate(),
        // Dropped by the screen: the quote is not in the transcript.
        candidate({ statement: "I like tea.", evidence: [{ entry_id: "u1", quote: "tea" }] }),
        // Dropped by selection: too unsure.
        candidate({ statement: "Prefers short replies.", confidence: 0.2 }),
      ),
    ];
    const started = await startAndWait(s);
    expect(started).toMatchObject({ ok: true, runId: s.runId, modelAlias: LEARNER });
    if (!started.ok) return;
    expect(started.input).toMatchObject({ entries: 2, partial: false, truncated: false });

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({
      purpose: "memory_learn",
      teamId: team,
      userId: owner.id,
      threadId: s.threadId,
      runId: s.runId,
      passId: started.passId,
      model: `openai/${LEARNER}`,
      structured: true,
    });
    const row = await passRow(started.passId);
    expect(row).toMatchObject({ status: "completed", error: null, to_entry_id: "a1" });
    expect(row?.usage).toMatchObject({
      model_alias: LEARNER,
      attempts: 1,
      input: { entries: 2, partial: false },
      counts: { replied: 3, stored: 1, dropped: 2 },
    });
    const stored = await candidatesOf(started.passId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload).toMatchObject({
      statement: "I prefer metric units.",
      destination: "user",
      statement_hash: statementHash("I prefer metric units."),
    });
    expect(await watermarkOf(s.threadId)).toBe("a1");
    // To review's bell notice and its reminder (KOBE-396), with the pass.
    const notice = await fx.admin.query(
      `SELECT item_count, memory_object_id FROM notifications
        WHERE team_id = $1 AND user_id = $2 AND thread_id = $3
          AND kind = 'memory.review.candidates_ready'`,
      [team, owner.id, s.threadId],
    );
    expect(notice.rows).toEqual([{ item_count: 1, memory_object_id: started.passId }]);
    const reminder = await fx.admin.query(
      `SELECT related_kind FROM memory_reminders WHERE team_id = $1 AND object_id = $2`,
      [team, started.passId],
    );
    expect(reminder.rows).toEqual([{ related_kind: null }]);
    expect((await passEvents(s.runId)).map((e) => [e.type, e.payload.stage ?? null])).toEqual([
      ["memory.pass.progress", "reading"],
      ["memory.pass.progress", "extracting"],
      ["memory.pass.progress", "checking"],
      ["memory.pass.completed", null],
    ]);
    expect((await passEvents(s.runId)).at(-1)?.payload).toEqual({
      pass_id: started.passId,
      thread_id: s.threadId,
      candidates: 1,
      dropped: 2,
      skill_hints: 0,
    });
    const audits = await passAudits(started.passId);
    expect(audits.map((a) => a.action)).toEqual(["memory.pass.started", "memory.pass.completed"]);
    for (const a of audits)
      expect(a).toMatchObject({ team_id: team, actor_kind: "user", actor_id: owner.id });
    expect(audits[0]?.target).toEqual({
      passId: started.passId,
      threadId: s.threadId,
      modelAlias: LEARNER,
      extractorVersion: CURRENT_EXTRACTOR_PROMPT.version,
      entries: 2,
      partial: false,
      truncated: false,
      summarised: false,
    });
    expect(audits[1]?.target).toEqual({
      passId: started.passId,
      threadId: s.threadId,
      replied: 3,
      stored: 1,
      dropped: 2,
      skillHints: 0,
      attempts: 1,
    });
    expectNoContent(
      audits,
      "metric",
      "Dana",
      "tea",
      "short replies",
      "The person said it",
      "Noted",
    );
    // Nothing is saved to memory without the person's review.
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM semantic_memory_items WHERE team_id = $1 AND owner_user_id = $2`,
      [team, owner.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("accepts an evidence id behind this pass's own fence nonce, no other (KOBE-672)", async () => {
    const s = await seedThread("I prefer ISO dates. My manager is Dana.");
    gateway.replies = [
      (input: ServerCallInput) => {
        const text = input.messages.map((m) => m.content).join("\n");
        const nonce = /<<<end ([0-9a-f]+)>>>/.exec(text)?.[1] ?? "missing";
        return reply(
          candidate({
            statement: "I prefer ISO dates.",
            evidence: [{ entry_id: `${nonce}:u1`, quote: "I prefer ISO dates" }],
          }),
          candidate({
            statement: "My manager is Dana.",
            kind: "fact",
            evidence: [{ entry_id: `${"0".repeat(32)}:u1`, quote: "My manager is Dana" }],
          }),
        );
      },
    ];
    const started = await startAndWait(s);
    if (!started.ok) throw new Error("pass did not start");
    expect((await passRow(started.passId))?.usage).toMatchObject({
      counts: { replied: 2, stored: 1, dropped: 1 },
    });
    const stored = await candidatesOf(started.passId);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.payload)).toContain('"entry_id":"u1"');
  });

  it("records a trace with the model, prompt version and counts", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry(
      {
        enabled: true,
        endpoint: "http://x:4318",
        headers: {},
        captureContent: false,
        serviceName: "t",
      },
      { exporter },
    );
    try {
      const s = await seedThread("I like dark mode.");
      gateway.replies = [
        reply(
          candidate({
            statement: "I like dark mode.",
            evidence: [{ entry_id: "u1", quote: "I like dark mode" }],
          }),
        ),
      ];
      const started = await startAndWait(s);
      const span = exporter.getFinishedSpans().find((x) => x.name === "memory.learn_pass");
      expect(span?.attributes).toMatchObject({
        "kobe.memory.pass_id": started.ok ? started.passId : "",
        "kobe.memory.model_alias": LEARNER,
        "kobe.memory.prompt_version": CURRENT_EXTRACTOR_PROMPT.version,
        "gen_ai.request.model": `openai/${LEARNER}`,
        "kobe.memory.candidates": 1,
        "kobe.memory.outcome": "completed",
      });
    } finally {
      await telemetry.shutdown();
    }
  });

  it("drops what is already open for review or was dismissed, and marks Policy conflicts", async () => {
    const policy = randomUUID();
    // The item and its first version reference each other (deferred key): one transaction.
    await fx.admin.query("BEGIN");
    await fx.admin.query(
      `INSERT INTO site_memory_items (id, kind, policy) VALUES ($1, 'fact', true)`,
      [policy],
    );
    await fx.admin.query(
      `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
       VALUES ($1, 1, 'Never share salaries outside payroll', $2, 'user')`,
      [policy, owner.id],
    );
    await fx.admin.query("COMMIT");
    const s = await seedThread(
      "I prefer metric units. I share salaries outside payroll. I hate jazz.",
    );
    const share = candidate({
      statement: "I share salaries outside payroll.",
      evidence: [{ entry_id: "u1", quote: "I share salaries outside payroll" }],
    });
    gateway.replies = [reply(candidate(), share)];
    await fx.admin.query(
      `INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash) VALUES ($1, $2, $3, $4)`,
      [team, s.threadId, owner.id, statementHash("i prefer METRIC units.")],
    );
    const started = await startAndWait(s);
    if (!started.ok) throw new Error(started.code);
    const stored = await candidatesOf(started.passId);
    expect(stored.map((c) => c.payload.statement)).toEqual(["I share salaries outside payroll."]);
    expect(stored[0]?.payload.policy_conflicts).toEqual([{ id: policy, version: 1 }]);

    // A later pass over new turns does not offer the open candidate again.
    await addEntries(s.threadId, [
      ["u2", "a1", msg("user", "Again: I share salaries outside payroll.")],
      ["a2", "u2", msg("assistant", "Ok.")],
    ]);
    await completedRun(s.threadId, "u2");
    gateway.replies = [
      reply({
        ...share,
        evidence: [{ entry_id: "u2", quote: "I share salaries outside payroll" }],
      }),
    ];
    const again = await startAndWait(s);
    if (!again.ok) throw new Error(again.code);
    expect(await candidatesOf(again.passId)).toEqual([]);
    expect((await passRow(again.passId))?.usage).toMatchObject({
      counts: { stored: 0, dropped: 1 },
    });
    await fx.admin.query(`DELETE FROM site_memory_items WHERE id = $1`, [policy]);
  });
});

describe("schema rejects and failures", () => {
  it("retries once on a schema reject, then completes", async () => {
    const s = await seedThread("I prefer metric units.");
    gateway.replies = ["not json", reply(candidate())];
    const started = await startAndWait(s);
    if (!started.ok) throw new Error(started.code);
    expect(gateway.calls).toHaveLength(2);
    expect(await passRow(started.passId)).toMatchObject({
      status: "completed",
      usage: expect.objectContaining({ attempts: 2 }),
    });
  });

  it("fails schema_rejected after the retry; the watermark stays put", async () => {
    const s = await seedThread("I prefer metric units.");
    gateway.replies = ["nope", { candidates: [{ statement: "x" }], skill_hints: [] }];
    const started = await startAndWait(s);
    if (!started.ok) throw new Error(started.code);
    expect(gateway.calls).toHaveLength(2);
    expect(await passRow(started.passId)).toMatchObject({
      status: "failed",
      error: "schema_rejected",
    });
    expect(await watermarkOf(s.threadId)).toBeNull();
    expect((await passEvents(s.runId)).at(-1)).toMatchObject({
      type: "memory.pass.failed",
      payload: { code: "schema_rejected", retryable: true },
    });
    const audits = await passAudits(started.passId);
    expect(audits.map((a) => a.action)).toEqual(["memory.pass.started", "memory.pass.failed"]);
    expect(audits[1]).toMatchObject({
      actor_kind: "user",
      actor_id: owner.id,
      target: {
        passId: started.passId,
        threadId: s.threadId,
        reason: "schema_rejected",
        attempts: 2,
      },
    });
    expectNoContent(audits, "metric", "nope");
  });

  it("maps a gateway budget refusal to budget_exhausted, not retryable (ac-2)", async () => {
    const s = await seedThread("I prefer metric units.");
    gateway.replies = [new ServerCallError("budget_exhausted", 402)];
    const started = await startAndWait(s);
    if (!started.ok) throw new Error(started.code);
    expect(gateway.calls).toHaveLength(1);
    expect((await passEvents(s.runId)).at(-1)).toMatchObject({
      type: "memory.pass.failed",
      payload: { code: "budget_exhausted", retryable: false },
    });
    expect((await passAudits(started.passId)).at(-1)?.target).toMatchObject({
      reason: "budget_exhausted",
      attempts: 1,
    });
  });

  it("fails learning_model_unavailable when the model is disabled after the start", async () => {
    const s = await seedThread("I prefer metric units.");
    const slow = new BackgroundTasks();
    const p = createLearningPasses({ db: fx.db, client: gateway, background: slow, log: NO_LOG });
    // Hold the background task until the model is gone.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const run = slow.run.bind(slow);
    slow.run = (failure, task, context) => run(failure, async () => (await gate, task()), context);
    const started = await p.start(viewer(), s.threadId);
    await fx.admin.query(`DELETE FROM team_models WHERE team_id = $1 AND alias = $2`, [
      team,
      LEARNER,
    ]);
    release();
    await slow.idle();
    await fx.admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, true, $3)`,
      [team, LEARNER, owner.id],
    );
    if (!started.ok) throw new Error(started.code);
    expect(gateway.calls).toHaveLength(0);
    expect(await passRow(started.passId)).toMatchObject({ status: "failed" });
    expect((await passEvents(s.runId)).at(-1)?.payload).toMatchObject({
      code: "learning_model_unavailable",
      retryable: false,
    });
  });
});
