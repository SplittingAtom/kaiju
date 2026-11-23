import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LEARN_NUDGE_MESSAGES, learnStateSchema, type LearnState } from "@kobe/protocol";
import { generateSessionKeyPair } from "@kobe/session-token";
import { SITE_SWITCH_KEYS } from "./switches.js";
import { TestBrowser } from "../testing/browser.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "../testing/event-stream-fixture.js";

/**
 * KOBE-410: the Learn nudge in `GET /v1/threads/{id}/learn` against Postgres: the message count
 * since the person's last pass, the correction signals (thumbs down, an edited message; not a
 * regenerate), the gates (only while the dot would show) and the Site switch, audited.
 */
const fx = new EventStreamFixture();
let owner: Person;
let team: string;
const LEARNER = `ln-${randomBytes(3).toString("hex")}`;
const PAIR = generateSessionKeyPair();
/** No pass runs here: any gateway call fails the test. */
const gatewayFetch: typeof fetch = () => Promise.reject(new Error("no model call expected"));

beforeAll(async () => {
  await fx.setup([{}], () => ({
    serverCalls: { gatewayUrl: "http://gateway.invalid", key: PAIR.signing, fetch: gatewayFetch },
  }));
  owner = await fx.person(`no${randomBytes(2).toString("hex")}`);
  team = await fx.team(`ln-${randomBytes(3).toString("hex")}`, owner, []);
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

afterEach(async () => {
  await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [
    SITE_SWITCH_KEYS.learnNudgeEnabled,
  ]);
});

afterAll(() => fx.teardown());

const msg = (role: "user" | "assistant", t: string) => ({
  message: { role, content: [{ type: "text", text: t }] },
});

type Entry = [id: string, parent: string | null, payload: object];

async function addEntries(threadId: string, list: Entry[], leaf = list.at(-1)?.[0]) {
  for (const [id, parent, payload] of list)
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [team, threadId, id, parent, JSON.stringify(payload)],
    );
  await fx.admin.query(`UPDATE threads SET leaf_entry_id = $3 WHERE team_id = $1 AND id = $2`, [
    team,
    threadId,
    leaf,
  ]);
}

async function completedRun(threadId: string, userEntry: string) {
  const runId = randomUUID();
  await fx.admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, ended_at, user_entry_id)
     VALUES ($1, $2, $3, 'user', 'completed', now(), now(), $4)`,
    [team, runId, threadId, userEntry],
  );
  await fx.admin.query(
    `INSERT INTO sandbox_run_leases (team_id, run_id, user_id, thread_id, sandbox_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [team, runId, owner.id, threadId, randomUUID()],
  );
  return runId;
}

/** `n` answered turns u1 → a1 → … → un → an, with a completed run on the first. */
function turns(n: number, from = 1, parent: string | null = null): Entry[] {
  const out: Entry[] = [];
  let p = parent;
  for (let i = from; i < from + n; i++) {
    out.push([`u${i}`, p, msg("user", `question ${i}`)]);
    out.push([`a${i}`, `u${i}`, msg("assistant", `answer ${i}`)]);
    p = `a${i}`;
  }
  return out;
}

async function seedThread(n: number): Promise<{ threadId: string; runId: string }> {
  const threadId = randomUUID();
  await fx.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    owner.id,
  ]);
  await addEntries(threadId, turns(n));
  return { threadId, runId: await completedRun(threadId, "u1") };
}

async function watermarkAt(threadId: string, entryId: string) {
  await fx.admin.query(
    `INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id)
     VALUES ($1, $2, $3, $4)`,
    [team, threadId, owner.id, entryId],
  );
}

async function thumbsDown(threadId: string, runId: string, at = "now()") {
  await fx.admin.query(
    `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'down', ${at}, ${at})`,
    [team, threadId, runId, owner.id],
  );
}

async function stateOf(threadId: string): Promise<LearnState> {
  const res = await owner.browser.get(`/v1/threads/${threadId}/learn`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return learnStateSchema.parse(res.json);
}

describe("the message count (ac-1, ac-2)", () => {
  it("no nudge below the threshold; the messages nudge at it, keyed from the start", async () => {
    const below = await seedThread(LEARN_NUDGE_MESSAGES - 1);
    expect((await stateOf(below.threadId)).nudge).toBeNull();
    const at = await seedThread(LEARN_NUDGE_MESSAGES);
    const s = await stateOf(at.threadId);
    expect(s.nudge).toEqual({ reason: "messages", key: "start:messages" });
    // A hint only: nothing started.
    expect(s.running).toBeNull();
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM memory_learning_passes WHERE team_id = $1 AND thread_id = $2`,
      [team, at.threadId],
    );
    expect(rows).toHaveLength(0);
  });

  it("counts only after the person's last pass (its watermark names the key)", async () => {
    const { threadId } = await seedThread(LEARN_NUDGE_MESSAGES + 2);
    await watermarkAt(threadId, "a3");
    expect((await stateOf(threadId)).nudge).toBeNull(); // 9 since a3
    await addEntries(threadId, turns(1, LEARN_NUDGE_MESSAGES + 3, `a${LEARN_NUDGE_MESSAGES + 2}`));
    expect((await stateOf(threadId)).nudge).toEqual({ reason: "messages", key: "a3:messages" });
  });

  it("on another branch, counts after the common ancestor with the watermark", async () => {
    const { threadId } = await seedThread(LEARN_NUDGE_MESSAGES);
    await watermarkAt(threadId, `a${LEARN_NUDGE_MESSAGES}`);
    // A branch from a2 (u3 regenerated, then 8 new turns): 9 after the fork point, not 11.
    await addEntries(threadId, [
      ["u3r", "a2", msg("user", "question 3")],
      ["a3r", "u3r", msg("assistant", "another answer 3")],
      ...turns(LEARN_NUDGE_MESSAGES - 2, 100, "a3r"),
    ]);
    expect((await stateOf(threadId)).nudge).toBeNull();
    // One more message on that branch reaches the threshold.
    await addEntries(threadId, turns(1, 200, `a${100 + LEARN_NUDGE_MESSAGES - 3}`));
    expect((await stateOf(threadId)).nudge?.reason).toBe("messages");
  });
});

describe("corrections (ac-1)", () => {
  it("a thumbs down since the last pass", async () => {
    const { threadId, runId } = await seedThread(2);
    expect((await stateOf(threadId)).nudge).toBeNull();
    await thumbsDown(threadId, runId);
    expect((await stateOf(threadId)).nudge).toEqual({
      reason: "correction",
      key: "start:correction",
    });
  });

  it("a thumbs down before the last pass does not count", async () => {
    const { threadId, runId } = await seedThread(2);
    await thumbsDown(threadId, runId, "now() - interval '1 hour'");
    await watermarkAt(threadId, "a1");
    expect((await stateOf(threadId)).nudge).toBeNull();
  });

  it("an edited message counts; a regenerate (same text again) does not", async () => {
    const { threadId } = await seedThread(2);
    await watermarkAt(threadId, "a1");
    await addEntries(threadId, [
      ["u2r", "a1", msg("user", "question 2")],
      ["a2r", "u2r", msg("assistant", "another answer 2")],
    ]);
    expect((await stateOf(threadId)).nudge).toBeNull();
    await addEntries(threadId, [
      ["u2e", "a1", msg("user", "No, I meant question two in metres")],
      ["a2e", "u2e", msg("assistant", "Sorry, in metres")],
    ]);
    expect((await stateOf(threadId)).nudge).toEqual({ reason: "correction", key: "a1:correction" });
  });
});

describe("gates and the Site switch (ac-1, ac-3)", () => {
  it("no nudge while Learn is blocked", async () => {
    const { threadId } = await seedThread(LEARN_NUDGE_MESSAGES);
    await fx.admin.query(`UPDATE threads SET is_test = true WHERE team_id = $1 AND id = $2`, [
      team,
      threadId,
    ]);
    const s = await stateOf(threadId);
    expect(s.blocker?.code).toBe("test_thread");
    expect(s.nudge).toBeNull();
  });

  it("the Site switch turns it off (audited) and back on", async () => {
    const { threadId } = await seedThread(LEARN_NUDGE_MESSAGES);
    const ia = await siteAdmin();
    const off = await ia.browser.put("/v1/memory/settings?level=site", {
      learn_nudge_enabled: false,
    });
    expect(off.status, off.text).toBe(200);
    expect(off.json).toMatchObject({ learn_nudge_enabled: false, learn_enabled: true });
    const { rows } = await fx.admin.query<{ target: { learnNudgeEnabled?: boolean } }>(
      `SELECT target FROM audit_log WHERE action = 'memory.site_settings_changed'
        ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows[0]?.target.learnNudgeEnabled).toBe(false);
    const s = await stateOf(threadId);
    expect(s.nudge).toBeNull();
    // Learn itself stays available: the dot still shows.
    expect(s).toMatchObject({ blocker: null, new_messages: true });
    await ia.browser.put("/v1/memory/settings?level=site", { learn_nudge_enabled: true });
    expect((await stateOf(threadId)).nudge?.reason).toBe("messages");
  });
});

let n = 0;
async function siteAdmin(): Promise<Person> {
  const email = `ln-ia${n++}-${randomUUID().slice(0, 6)}@events.test`;
  await fx
    .replica(0)
    .deps.createUserWithPassword(
      { email, name: "ia", password: "a long enough password" },
      { siteRole: "admin" },
    );
  const b = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", {
    email,
    password: "a long enough password",
  });
  expect(res.status).toBe(200);
  return { browser: b } as Person;
}
