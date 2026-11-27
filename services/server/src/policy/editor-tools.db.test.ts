import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_NOTEBOOKS } from "@kaiju/protocol";
import { createDb, type KaijuDatabase } from "@kaiju/db";
import { approvalKeyring } from "../approvals/index.js";
import { createPolicyEngine } from "./engine.js";
import { createDbRuleSource, createDbSettingsSource } from "./rule-store.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";

/**
 * KOBE-848 with the real policy engine: `editor_run` on the member's open `.py` file asks in
 * `ask-on-write` (approval card, signed approval, then allow), `editor_read` is allowed without
 * asking, and either on another file is denied by the editor-file guard (in `auto` too).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KaijuDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "e"));
const VIEWED = "src/analysis.py";

beforeAll(async () => {
  await fx.setup([{}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { pollMs: 100 },
      sandboxWire: {
        sweep: false,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
        }),
        tuning: { batchWindowMs: 20, resultPollMs: 200 },
      },
    };
  });
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
  for (const d of extraDbs) await d.close();
});

interface World {
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

async function world(mode: "ask-on-write" | "auto" = "ask-on-write"): Promise<World> {
  const owner = await fx.person(`p${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`ep-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const viewing = {
    path: VIEWED,
    sha256: "a".repeat(64),
    size: 3,
    content: "x=1",
    truncated: false,
  };
  await fx.admin.query(`UPDATE runs SET approval_mode = $3, viewing = $2::jsonb WHERE id = $1`, [
    runId,
    JSON.stringify(viewing),
    mode,
  ]);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, [], undefined, [CAPABILITY_NOTEBOOKS]);
  await sb.ready();
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { owner, runId, threadId, sb };
}

let next = 0;
function check(w: World, tool: string, input: Record<string, unknown>) {
  const requestId = `e${(next += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: `call-${requestId}`,
    tool,
    input,
  });
  return {
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
  };
}

describe("editor tools under the real policy engine (KOBE-848)", () => {
  it("editor_run asks the member; once approved the call is allowed", async () => {
    const w = await world();
    const call = check(w, "editor_run", { path: `/workspace/${VIEWED}` });
    const pending = await call.pending();
    const card = await w.owner.browser.get(`/v1/approvals/${pending.approval_id}`);
    expect(card.status, JSON.stringify(card.json)).toBe(200);
    expect(JSON.stringify(card.json)).toContain("editor_run");
    const allowed = await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, {
      decision: "allow",
    });
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
    expect((await call.result()).decision).toBe("allow");
  });

  it("a denied approval refuses the run", async () => {
    const w = await world();
    const call = check(w, "editor_run", { path: VIEWED });
    const pending = await call.pending();
    await w.owner.browser.post(`/v1/approvals/${pending.approval_id}`, { decision: "deny" });
    expect((await call.result()).decision).toBe("deny");
  });

  it("editor_read is allowed without asking; another file is denied without asking", async () => {
    const w = await world();
    expect(
      (await check(w, "editor_read", { path: VIEWED, what: "variables" }).result()).decision,
    ).toBe("allow");
    const other = await check(w, "editor_run", { path: "src/other.py" }).result();
    expect(other.decision).toBe("deny");
    expect(other.reasons[0]).toMatchObject({ code: "editor_file" });
    expect(w.sb.frames("policy.pending")).toHaveLength(0);
  });

  it("auto mode denies editor_run (nobody to ask) but reads", async () => {
    const w = await world("auto");
    expect((await check(w, "editor_run", { path: VIEWED }).result()).decision).toBe("deny");
    expect((await check(w, "editor_read", { path: VIEWED, what: "log" }).result()).decision).toBe(
      "allow",
    );
  });
});
