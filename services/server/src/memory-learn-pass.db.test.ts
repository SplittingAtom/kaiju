import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_PASS_MAX_MS, type MemoryExtractorCandidate } from "@kobe/protocol";
import { InMemorySpanExporter, initTelemetry } from "@kobe/telemetry";
import { BackgroundTasks } from "./background.js";
import { AppendError, appendRunEvents } from "./event-stream/append.js";
import {
  ServerCallError,
  type ServerCallClient,
  type ServerCallInput,
} from "./models/gateway-client.js";
import { LEARN_PASSES_PER_DAY } from "./memory/learn/passes.js";
import { CURRENT_EXTRACTOR_PROMPT } from "./memory/learn/prompt/index.js";
import { createLearningPasses, type LearningPasses } from "./memory/learn/run.js";
import { statementHash } from "./memory/learn/validate.js";
import { EventStreamFixture, delta, type Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-393 (SMB5; SM14, SM15, SM16, Q5): a learning pass end to end against Postgres with a
 * scripted model gateway: start checks, the DB's one-pass-per-thread rule across replicas, the
 * extractor call and its retry, validation and candidates, the watermark, pass events on the
 * thread's run (and the append guard), the stale-pass sweep and the trace.
 */
const fx = new EventStreamFixture();
let owner: Person;
let mate: Person;
let team: string;
const LEARNER = `lp-${randomBytes(3).toString("hex")}`;
const NO_LOG = { info: () => undefined, warn: () => undefined };

/** A scripted gateway: each call takes the next reply (a JSON value, raw text, or an error). */
class FakeGateway implements ServerCallClient {
  readonly calls: ServerCallInput[] = [];
  replies: (unknown | Error)[] = [];
  async complete(input: ServerCallInput): Promise<string> {
    this.calls.push(input);
    const next = this.replies.shift() ?? { candidates: [], skill_hints: [] };
    if (next instanceof Error) throw next;
    return typeof next === "string" ? next : JSON.stringify(next);
  }
}

let gateway: FakeGateway;
let background: BackgroundTasks;
let passes: LearningPasses;
const passesOn = (replica: number) =>
  createLearningPasses({
    db: fx.replica(replica).deps.database.db,
    client: gateway,
    background,
    log: NO_LOG,
  });

beforeAll(async () => {
  await fx.setup([{}, {}]);
  owner = await fx.person(`po${randomBytes(2).toString("hex")}`);
  mate = await fx.person(`pm${randomBytes(2).toString("hex")}`);
  team = await fx.team(`lp-${randomBytes(3).toString("hex")}`, owner, [mate]);
  await fx.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [owner.id],
  );
  for (const alias of [LEARNER, `${LEARNER}-off`])
    await fx.admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ($1, 'openai', $1, $2)`,
      [alias, owner.id],
    );
  await fx.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, true, $3)`,
    [team, LEARNER, owner.id],
  );
  await siteLearner(LEARNER);
});

afterAll(() => fx.teardown());

beforeEach(() => {
  gateway = new FakeGateway();
  background = new BackgroundTasks();
  passes = passesOn(0);
});

async function siteLearner(alias: string | null) {
  await fx.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ learning_model_alias: alias })],
  );
}

const text = (t: string) => [{ type: "text", text: t }];
const msg = (role: "user" | "assistant", t: string) => ({ message: { role, content: text(t) } });

interface Seeded {
  readonly threadId: string;
  readonly runId: string;
}

/**
 * A thread of `who` with u1 (person) → a1 (assistant), the leaf, and one completed run answering
 * u1, leased to them, its run.completed written.
 */
async function seedThread(said: string, who: Person = owner): Promise<Seeded> {
  const threadId = randomUUID();
  await fx.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    who.id,
  ]);
  await addEntries(threadId, [
    ["u1", null, msg("user", said)],
    ["a1", "u1", msg("assistant", "Noted.")],
  ]);
  const runId = await completedRun(threadId, "u1", who);
  return { threadId, runId };
}

async function addEntries(threadId: string, list: [string, string | null, object][]) {
  for (const [id, parent, payload] of list)
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [team, threadId, id, parent, JSON.stringify(payload)],
    );
  await fx.admin.query(`UPDATE threads SET leaf_entry_id = $3 WHERE team_id = $1 AND id = $2`, [
    team,
    threadId,
    list.at(-1)?.[0],
  ]);
}

async function completedRun(threadId: string, userEntry: string, who: Person = owner) {
  const runId = randomUUID();
  await fx.admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, ended_at, user_entry_id)
     VALUES ($1, $2, $3, 'user', 'completed', now(), now(), $4)`,
    [team, runId, threadId, userEntry],
  );
  await fx.admin.query(
    `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [team, runId, who.id, threadId, randomUUID()],
  );
  await appendRunEvents(fx.db, team, runId, [
    { type: "run.completed", payload: { leaf_entry_id: null } },
  ]);
  return runId;
}

const viewer = (who: Person = owner) => ({ teamId: team, userId: who.id, projectIds: [] });

const candidate = (over: Partial<MemoryExtractorCandidate> = {}): MemoryExtractorCandidate => ({
  statement: "I prefer metric units.",
  kind: "preference",
  suggested_scope: "user",
  portable: false,
  project_specific: false,
  source: "stated",
  operation: "add",
  target_id: null,
  confidence: 0.9,
  rationale: "The person said it.",
  evidence: [{ entry_id: "u1", quote: "I prefer metric units" }],
  ...over,
});
const reply = (...candidates: MemoryExtractorCandidate[]) => ({ candidates, skill_hints: [] });

async function passRow(passId: string) {
  const { rows } = await fx.admin.query<{
    status: string;
    error: string | null;
    to_entry_id: string | null;
    usage: Record<string, unknown> | null;
  }>(`SELECT status, error, to_entry_id, usage FROM memory_learning_passes WHERE id = $1`, [
    passId,
  ]);
  return rows[0];
}

async function candidatesOf(passId: string) {
  const { rows } = await fx.admin.query<{ ord: number; payload: Record<string, unknown> }>(
    `SELECT ord, payload FROM memory_candidates WHERE pass_id = $1 ORDER BY ord`,
    [passId],
  );
  return rows;
}

async function watermarkOf(threadId: string, who: Person = owner) {
  const { rows } = await fx.admin.query<{ entry_id: string }>(
    `SELECT entry_id FROM memory_learning_watermarks WHERE thread_id = $1 AND user_id = $2`,
    [threadId, who.id],
  );
  return rows[0]?.entry_id ?? null;
}

async function passEvents(runId: string) {
  const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM run_events WHERE run_id = $1 AND type LIKE 'memory.pass.%' ORDER BY seq`,
    [runId],
  );
  return rows;
}

/** The pass's audit rows in order; a pass id is unique, so this filters by the target. */
async function passAudits(passId: string) {
  const { rows } = await fx.admin.query<{
    action: string;
    team_id: string | null;
    actor_kind: string;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, team_id, actor_kind, actor_id, target FROM audit_log
      WHERE action LIKE 'memory.pass.%' AND target->>'passId' = $1 ORDER BY seq`,
    [passId],
  );
  return rows;
}

/** No audit row carries a statement, quote, rationale or message text (KOBE-393). */
function expectNoContent(rows: { target: Record<string, unknown> }[], ...texts: string[]) {
  const all = JSON.stringify(rows.map((r) => r.target)).toLowerCase();
  for (const t of [...texts, "statement", "quote", "evidence", "rationale", "message"])
    expect(all).not.toContain(t.toLowerCase());
}

async function startAndWait(s: Seeded, who: Person = owner) {
  const started = await passes.start(viewer(who), s.threadId);
  await background.idle();
  return started;
}

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
    const s = await seedThread("I prefer metric units.");
    const results = await Promise.all([
      passesOn(0).start(viewer(), s.threadId),
      passesOn(1).start(viewer(), s.threadId),
    ]);
    await background.idle();
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "pass_running" });
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
