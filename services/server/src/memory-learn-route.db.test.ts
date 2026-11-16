import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  learnRefusalSchema,
  learnStartResponseSchema,
  learnStateSchema,
  listNotificationsResponseSchema,
  type LearnState,
} from "@kobe/protocol";
import { generateSessionKeyPair } from "@kobe/session-token";
import { appendRunEvents } from "./event-stream/append.js";
import { LEARN_PASSES_PER_DAY } from "./memory/learn/passes.js";
import { passErrorMessage } from "./memory/learn/state.js";
import { TestBrowser } from "./testing/browser.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-395: `GET/POST /v1/threads/{id}/learn` against Postgres, the server's real learning passes
 * and a gateway stand-in: the state the + button reads (blocker, running pass, dot, candidates,
 * estimate), the start (202) and its refusals, owner only. KOBE-661: a pass started and run on one
 * replica reaches the browser through the other (its Learn state and the pass's events).
 */
const fx = new EventStreamFixture();
const PAIR = generateSessionKeyPair();
let owner: Person;
let mate: Person;
let team: string;
const LEARNER = `lr-${randomBytes(3).toString("hex")}`;

/** While set, extractor calls wait for it (a pass held running, KOBE-661). */
let hold: Promise<void> | null = null;

/** Every extractor call answers one candidate quoting u1. */
const gatewayFetch: typeof fetch = async () => {
  if (hold) await hold;
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              candidates: [
                {
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
                },
              ],
              skill_hints: [],
            }),
          },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

beforeAll(async () => {
  // Two replicas on one database, as gate1 runs (KOBE-661).
  await fx.setup([{}, {}], () => ({
    serverCalls: { gatewayUrl: "http://gateway.invalid", key: PAIR.signing, fetch: gatewayFetch },
  }));
  owner = await fx.person(`lo${randomBytes(2).toString("hex")}`);
  mate = await fx.person(`lm${randomBytes(2).toString("hex")}`);
  team = await fx.team(`lr-${randomBytes(3).toString("hex")}`, owner, [mate]);
  await fx.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [owner.id],
  );
  await fx.admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ($1, 'openai', $1, $2)`,
    [LEARNER, owner.id],
  );
  await fx.admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, true, $3)`,
    [team, LEARNER, owner.id],
  );
  await fx.admin.query(
    `INSERT INTO site_settings (key, value) VALUES ('memory.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ learning_model_alias: LEARNER })],
  );
});

afterAll(() => fx.teardown());

const msg = (role: "user" | "assistant", t: string) => ({
  message: { role, content: [{ type: "text", text: t }] },
});

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

async function completedRun(threadId: string, userEntry: string, who: Person) {
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

/** A thread of `who`: u1 → a1 with a completed run (unless `run` is false). */
async function seedThread(who: Person = owner, opts: { run?: boolean; test?: boolean } = {}) {
  const threadId = randomUUID();
  await fx.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, is_test) VALUES ($1, $2, $3, $4)`,
    [team, threadId, who.id, opts.test === true],
  );
  await addEntries(threadId, [
    ["u1", null, msg("user", "I prefer metric units.")],
    ["a1", "u1", msg("assistant", "Noted.")],
  ]);
  if (opts.run !== false) await completedRun(threadId, "u1", who);
  return threadId;
}

const path = (threadId: string) => `/v1/threads/${threadId}/learn`;

async function stateOf(threadId: string, who: Person = owner, q = ""): Promise<LearnState> {
  const res = await who.browser.get(`${path(threadId)}${q}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return learnStateSchema.parse(res.json);
}

describe("GET /v1/threads/{id}/learn (KOBE-395)", () => {
  it("a fresh answered thread: available, the dot on, nothing waiting", async () => {
    const t = await seedThread();
    const s = await stateOf(t);
    expect(s).toMatchObject({
      thread_id: t,
      blocker: null,
      running: null,
      new_messages: true,
      candidates: 0,
      passes_left: expect.any(Number),
      last_failure: null,
      estimate: null,
    });
  });

  it("estimates what /learn and /learn all read when asked", async () => {
    const t = await seedThread();
    const s = await stateOf(t, owner, "?estimate=1");
    expect(s.estimate?.all_tokens).toBeGreaterThan(0);
    expect(s.estimate?.new_tokens).toBeGreaterThan(0);
  });

  it("names the blocker: no completed run, a test chat", async () => {
    expect((await stateOf(await seedThread(owner, { run: false }))).blocker?.code).toBe(
      "no_completed_run",
    );
    expect((await stateOf(await seedThread(owner, { test: true }))).blocker?.code).toBe(
      "test_thread",
    );
  });

  it("names the switch when Learn is off for the Workspace", async () => {
    const t = await seedThread();
    await fx.admin.query(
      `UPDATE teams SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('memory', $2::jsonb)
        WHERE id = $1`,
      [team, JSON.stringify({ learn_enabled: false })],
    );
    try {
      expect((await stateOf(t)).blocker).toMatchObject({
        code: "memory_disabled",
        reason: "learn_off",
      });
    } finally {
      await fx.admin.query(`UPDATE teams SET settings = settings - 'memory' WHERE id = $1`, [team]);
    }
  });

  it("a shared reader gets 403 read_only, another member's private thread 404", async () => {
    const t = await seedThread();
    const res = await mate.browser.get(path(t));
    expect(res.status).toBe(404);
    expect(learnRefusalSchema.parse(res.json).code).toBe("thread_not_found");
    await fx.admin.query(
      `UPDATE threads SET shared_to_team = true WHERE team_id = $1 AND id = $2`,
      [team, t],
    );
    const shared = await mate.browser.get(path(t));
    expect(shared.status).toBe(403);
    expect(shared.json.code).toBe("read_only");
  });

  it("refuses a bad id", async () => {
    expect((await owner.browser.get(path("nope"))).status).toBe(400);
  });
});

describe("POST /v1/threads/{id}/learn (KOBE-395)", () => {
  it("starts a pass (202); the state shows it running, then the candidate and no dot", async () => {
    const t = await seedThread();
    const res = await owner.browser.post(path(t), {});
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    const started = learnStartResponseSchema.parse(res.json);
    expect(started).toMatchObject({ model_alias: LEARNER, mode: "new" });
    expect((await stateOf(t)).running?.pass_id).toBe(started.pass_id);
    await fx.replica(0).deps.background.idle();
    const after = await stateOf(t);
    expect(after).toMatchObject({ running: null, new_messages: false, candidates: 1 });

    // Nothing new: /learn refuses, /learn all rescans.
    const again = await owner.browser.post(path(t), { mode: "new" });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: "nothing_to_learn", leaf_entry_id: "a1" });
    const all = await owner.browser.post(path(t), { mode: "all" });
    expect(all.status, JSON.stringify(all.json)).toBe(202);
    expect(all.json.mode).toBe("all");
    await fx.replica(0).deps.background.idle();
  });

  it("answers pass_running while a pass is active", async () => {
    const t = await seedThread();
    await fx.admin.query(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status, started_at)
       VALUES ($1, $2, $3, 'a1', 'm', 'v1', 'running', now())`,
      [team, t, owner.id],
    );
    const res = await owner.browser.post(path(t), { mode: "new" });
    expect(res.status).toBe(409);
    expect(learnRefusalSchema.parse(res.json).code).toBe("pass_running");
  });

  it("shows the last failure and the rate limit", async () => {
    const who = await fx.person(`lr${randomBytes(2).toString("hex")}`);
    await fx.addMember(team, who);
    await fx.activate(who, team);
    const t = await seedThread(who);
    await fx.admin.query(
      `INSERT INTO memory_learning_passes
         (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status,
          error, started_at, finished_at)
       SELECT $1, $2, $3, 'a1', 'm', 'v1', 'failed', 'timeout', now(), now() FROM generate_series(1, $4)`,
      [team, t, who.id, LEARN_PASSES_PER_DAY],
    );
    const s = await stateOf(t, who);
    expect(s.passes_left).toBe(0);
    expect(s.blocker?.code).toBe("learn_rate_limited");
    expect(s.last_failure?.message).toMatch(/too long/);
    const res = await who.browser.post(path(t), {});
    expect(res.status).toBe(429);
  });

  it("refuses a reader of a shared thread and a bad body", async () => {
    const t = await seedThread();
    await fx.admin.query(
      `UPDATE threads SET shared_to_team = true WHERE team_id = $1 AND id = $2`,
      [team, t],
    );
    const res = await mate.browser.post(path(t), {});
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("read_only");
    expect((await owner.browser.post(path(t), { mode: "x" })).status).toBe(400);
  });
});

describe("a pass that ran on another replica (KOBE-661)", () => {
  /** The same signed-in tab, its requests served by replica `i` (the ingress balances them). */
  const tabOn = (i: number, who: Person): TestBrowser => {
    const tab = new TestBrowser(fx.replica(i).app, PUBLIC_URL);
    for (const [k, v] of who.browser.cookies) tab.cookies.set(k, v);
    tab.team = who.browser.team;
    return tab;
  };

  it("its completion reaches the browser through the other replica: state and events", async () => {
    // Someone new: the candidate isn't already waiting for review from an earlier test.
    const who = await fx.person(`lx${randomBytes(2).toString("hex")}`);
    await fx.addMember(team, who);
    await fx.activate(who, team);
    const t = await seedThread(who);
    let release: () => void = () => undefined;
    hold = new Promise<void>((r) => {
      release = r;
    });
    // Started on replica 0, which runs the pass on its own background tasks.
    const res = await tabOn(0, who).post(path(t), { mode: "new" });
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    const started = learnStartResponseSchema.parse(res.json);
    const onOther = tabOn(1, who);
    // Replica 1 runs nothing of it, yet it sees the running pass...
    const before = await onOther.get(path(t));
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    expect(learnStateSchema.parse(before.json).running?.pass_id).toBe(started.pass_id);
    hold = null;
    release();
    await fx.replica(0).deps.background.idle();
    // ...and its end: no running pass, the candidate waiting, the dot off (Postgres is the record).
    const after = learnStateSchema.parse((await onOther.get(path(t))).json);
    expect(after).toMatchObject({ running: null, new_messages: false, candidates: 1 });
    expect(after.last_failure).toBeNull();
    // The bell's To review notice, written with the pass, is there too.
    const bell = listNotificationsResponseSchema.parse(
      (await onOther.get("/v1/notifications")).json,
    );
    expect(
      bell.notifications.filter(
        (n) =>
          n.kind === "memory.review.candidates_ready" && n.memory_object_id === started.pass_id,
      ),
    ).toHaveLength(1);
  });
});

describe("passErrorMessage", () => {
  it("turns a pass row's error into a sentence", () => {
    expect(passErrorMessage("interrupted: the server stopped")).toMatch(/server stopped/);
    expect(passErrorMessage("schema_rejected")).toMatch(/couldn't be read/);
    expect(passErrorMessage("weird")).toMatch(/didn't finish/);
  });
});
