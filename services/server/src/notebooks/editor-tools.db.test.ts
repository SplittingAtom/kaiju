import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOK_INSPECT,
  CAPABILITY_NOTEBOOKS,
  type PolicyEngine,
} from "@kaiju/protocol";
import { type SandboxToServerFrame, type ServerToSandboxFrame } from "@kaiju/protocol/sandbox-wire";
import { withTeam } from "@kaiju/db";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "../workspace-sync/index.js";

/**
 * KOBE-848 end to end against a fake sandbox: the agent's `editor_run` (rides `notebook.run`, runs
 * the member's open `.py` file in the thread's kernel, recorded like any agent execution so the
 * run pane shows it, audited `run.editor_run`) and `editor_read` (`editor.read`: the run pane's
 * Run Output, Log and Variables as bounded text, audited `run.editor_read`); the editor-file
 * guard after the engine (only the run's viewed `.py` file); concurrency with the member's Run.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 4 * 1024 * 1024, maxWorkspaceBytes: 16 * 1024 * 1024, maxFiles: 50 };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let siteAdmin: Person;
let sync: ReturnType<typeof createWorkspaceSync>;

/** The engine allows everything: these tests are about the guard and the frames after it. */
const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "write" as const,
      reasons: [{ code: "risk_read" as const, stage: "risk_class" as const, message: "ok" }],
    }),
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      engine: allowAll,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 100, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
    runs: { sweep: false },
  }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  fx.replica(0).deps.notebookFiles.use(sync);
  listener = await sandboxListener(fx.replica(0).deps, auth);
  siteAdmin = await fx.person("edsiteadmin");
  await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
    siteAdmin.id,
  ]);
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(): Promise<World> {
  const owner = await fx.person(`e${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`ed-${randomBytes(3).toString("hex")}`, owner, []);
  const threadId = randomUUID();
  await fx.admin.query(
    `INSERT INTO threads (id, team_id, owner_user_id, title) VALUES ($1, $2, $3, 'ed')`,
    [threadId, team, owner.id],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    threadId,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

const SNAPSHOT = {
  status: "ok",
  taken_at: "2026-11-26T10:00:00.000Z",
  execution_count: 3,
  variables: [
    { name: "total", type: "int", repr: "42" },
    { name: "api_key", type: "str", repr: "", hidden: "name", len: 32 },
    // A token under a name the sandbox's heuristic misses (review M1).
    { name: "x", type: "str", repr: "'sk-proj-TOKEN1234'", len: 17 },
  ],
  other: [],
  truncated: false,
};

type ExecuteFrame = Extract<ServerToSandboxFrame, { type: "notebook.execute" }>;

async function connected(
  w: World,
  capabilities: readonly string[] = [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT],
  hold?: Promise<void>,
) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.respond = (frame): SandboxToServerFrame | null | undefined => {
    if (frame.type === "notebook.inspect") {
      return {
        v: 1,
        type: "command.result",
        command_id: frame.command_id,
        ok: true,
        data: SNAPSHOT,
      };
    }
    if (frame.type === "notebook.interrupt") {
      return {
        v: 1,
        type: "command.result",
        command_id: frame.command_id,
        ok: true,
        data: { status: "interrupted" },
      };
    }
    if (frame.type !== "notebook.execute") return undefined;
    const answer = (f: ExecuteFrame): SandboxToServerFrame => {
      sb.send({
        v: 1,
        type: "notebook.output",
        command_id: f.command_id,
        thread_id: f.thread_id,
        index: 0,
        output: { output_type: "stream", name: "stdout", text: `ran: ${f.code}` },
      });
      return {
        v: 1,
        type: "command.result",
        command_id: f.command_id,
        ok: true,
        data: {
          status: hold ? "interrupted" : "ok",
          execution_count: 4,
          outputs: 1,
          truncated: false,
        },
      };
    };
    if (hold) {
      void hold.then(() => sb.send(answer(frame)));
      return null; // answered once released
    }
    return answer(frame);
  };
  sb.hello(w.sandboxId, [], undefined, capabilities);
  await sb.ready();
  return sb;
}

async function seed(w: World, path: string, content: string) {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: w.owner.id };
  const sha256 = createHash("sha256").update(data).digest("hex");
  objects.objects.set(workspaceBlobKey("", owner, sha256), data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(
      tx,
      owner,
      { path, sha256, size: data.length, blobKey: workspaceBlobKey("", owner, sha256) },
      "user",
    ),
  );
}

/** The agent's run, with `viewing` as the member's open file (set after run.start). */
async function agentRun(w: World, viewing: string | null) {
  const runId = randomUUID();
  await fx.admin.query(
    `INSERT INTO runs (id, team_id, thread_id, trigger, status, started_at)
     VALUES ($1, $2, $3, 'user', 'running', now())`,
    [runId, w.team, w.threadId],
  );
  await fx.admin.query(`UPDATE threads SET status = 'running' WHERE id = $1`, [w.threadId]);
  const res = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: w.team, userId: w.owner.id },
      { runId, threadId: w.threadId, message: "hi" },
    );
  expect(res).toEqual({ ok: true });
  if (viewing !== null) {
    await fx.admin.query(`UPDATE runs SET viewing = $2::jsonb WHERE id = $1`, [
      runId,
      JSON.stringify({ path: viewing }),
    ]);
  }
  return runId;
}

let seq = 0;
async function check(
  sb: FakeSandbox,
  w: World,
  runId: string,
  callId: string,
  tool: string,
  input: unknown,
) {
  const request_id = `c${seq++}`;
  sb.send({
    v: 1,
    type: "policy.check",
    request_id,
    run_id: runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool,
    input: input as Record<string, unknown>,
  });
  return sb.until(
    () => sb.frames("policy.result").find((r) => r.request_id === request_id),
    15_000,
  );
}

async function editorRun(
  sb: FakeSandbox,
  w: World,
  runId: string,
  callId: string,
  input: Record<string, unknown>,
) {
  const request_id = `n${seq++}`;
  sb.send({
    v: 1,
    type: "notebook.run",
    request_id,
    run_id: runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "editor_run",
    input: input as { path: string },
  });
  return sb.until(
    () => sb.frames("notebook.run_result").find((r) => r.request_id === request_id),
    15_000,
  );
}

async function editorRead(sb: FakeSandbox, w: World, runId: string, callId: string, what: string) {
  const input = { path: "/workspace/analysis.py", what } as const;
  expect(await check(sb, w, runId, callId, "editor_read", input)).toMatchObject({
    decision: "allow",
  });
  const request_id = `r${seq++}`;
  sb.send({
    v: 1,
    type: "editor.read",
    request_id,
    run_id: runId,
    thread_id: w.threadId,
    tool_call_id: callId,
    tool: "editor_read",
    input: input as never,
  });
  return sb.until(
    () => sb.frames("editor.read_result").find((r) => r.request_id === request_id),
    15_000,
  );
}

/** Audit rows are written off the frame path: wait until `count` rows are there. */
async function auditsN(team: string, action: string, count: number) {
  await expect.poll(async () => (await audits(team, action)).length).toBe(count);
  return audits(team, action);
}

async function audits(team: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

describe("editor_run (KOBE-848)", { timeout: 60_000 }, () => {
  it("runs the open .py file in the kernel, recorded as the agent's run and audited", async () => {
    const w = await world();
    const sb = await connected(w);
    await seed(w, "analysis.py", "print(6 * 7)\n");
    const runId = await agentRun(w, "analysis.py");
    // Normalised like the guard: a `.` segment neither refuses nor wastes the approval.
    const input = { path: "/workspace/./analysis.py" };
    expect(await check(sb, w, runId, "call-1", "editor_run", input)).toMatchObject({
      decision: "allow",
    });
    const answer = await editorRun(sb, w, runId, "call-1", input);
    expect(answer).toMatchObject({
      ok: true,
      op: "notebook_run",
      status: "ok",
      execution_count: 4,
    });
    expect(sb.frames("notebook.execute")).toMatchObject([
      { code: "print(6 * 7)\n", run_id: runId, with_timing: true },
    ]);
    const { rows } = await fx.admin.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type LIKE 'notebook.%' ORDER BY seq`,
      [w.team, runId],
    );
    expect(rows.map((r) => r.type)).toEqual([
      "notebook.started",
      "notebook.output",
      "notebook.finished",
    ]);
    expect(rows[0]?.payload).toMatchObject({
      origin: "agent",
      tool_call_id: "call-1",
      path: "analysis.py",
    });
    expect(await auditsN(w.team, "run.editor_run", 1)).toEqual([
      { userId: w.owner.id, threadId: w.threadId, runId, toolCallId: "call-1", status: "ok" },
    ]);
  });

  it("is denied for another file or without an open file, whatever the engine says", async () => {
    const w = await world();
    const sb = await connected(w);
    await seed(w, "other.py", "print(1)\n");
    const runId = await agentRun(w, "analysis.py");
    const other = await check(sb, w, runId, "call-o", "editor_run", { path: "other.py" });
    expect(other).toMatchObject({ decision: "deny" });
    expect(JSON.stringify(other)).toContain("editor_file");
    // A frame without the allowed check runs nothing.
    const direct = await editorRun(sb, w, runId, "call-o", { path: "other.py" });
    expect((direct as { error?: { code: string } }).error?.code).toBe("not_allowed");
    // Refusals are audited too.
    await expect
      .poll(async () => (await audits(w.team, "run.editor_run")).map((t) => t.status))
      .toEqual(["refused"]);
    const w2 = await world();
    const sb2 = await connected(w2);
    const run2 = await agentRun(w2, null);
    expect(
      await check(sb2, w2, run2, "c", "editor_read", { path: "a.py", what: "log" }),
    ).toMatchObject({ decision: "deny" });
    expect(sb.frames("notebook.execute")).toEqual([]);
  });
});

describe("editor_read (KOBE-848)", { timeout: 60_000 }, () => {
  it("reads Run Output, Log and Variables of the open file, audited without content", async () => {
    const w = await world();
    const sb = await connected(w);
    await seed(w, "analysis.py", "x = 1\n");
    const runId = await agentRun(w, "analysis.py");
    const empty = await editorRead(sb, w, runId, "r0", "output");
    expect(empty).toMatchObject({
      ok: true,
      what: "output",
      text: "analysis.py has not been run in this conversation yet.",
    });
    const input = { path: "analysis.py" };
    await check(sb, w, runId, "run-1", "editor_run", input);
    await editorRun(sb, w, runId, "run-1", input);
    const output = await editorRead(sb, w, runId, "r1", "output");
    expect(output).toMatchObject({ ok: true, truncated: false });
    expect((output as { text: string }).text).toMatch(
      /^Newest run of analysis.py: .* · by agent · done · \[4\]\n\nran: x = 1\n$/u,
    );
    const log = await editorRead(sb, w, runId, "r2", "log");
    expect((log as { text: string }).text).toContain("Runs of analysis.py, newest first:\n- ");
    const vars = await editorRead(sb, w, runId, "r3", "variables");
    const varsText = (vars as { text: string }).text;
    expect(varsText).toContain("- total: int = 42");
    // Default off: the token in `x` is withheld, and the result says values were withheld.
    expect(varsText).toContain("- x: str (len 17) (value not shown to the agent)");
    expect(varsText).not.toContain("sk-proj");
    expect(varsText).toContain("Values of strings, bytes and containers are withheld");
    expect((vars as { text: string }).text).toContain(
      "- api_key: str (len 32) = (value hidden: credential-like name)",
    );
    // The snapshot was asked for without show or refresh.
    expect(sb.frames("notebook.inspect")).toEqual([
      expect.not.objectContaining({ show: expect.anything(), refresh: expect.anything() }),
    ]);
    expect((await auditsN(w.team, "run.editor_read", 4)).map((t) => t.what)).toEqual([
      "output",
      "output",
      "log",
      "variables",
    ]);
    const all = JSON.stringify(await audits(w.team, "run.editor_read"));
    expect(all).not.toContain("analysis.py");
    // Ids and the tab only: no path, value or output field (a random id may contain "42").
    for (const target of await audits(w.team, "run.editor_read")) {
      expect(Object.keys(target).sort()).toEqual([
        "outcome",
        "runId",
        "threadId",
        "toolCallId",
        "userId",
        "what",
      ]);
    }
    expect((await audits(w.team, "run.editor_read")).map((t) => t.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("shows string and container values only when the team's setting turns them on", async () => {
    const w = await world();
    const sb = await connected(w);
    const runId = await agentRun(w, "analysis.py");
    const read = async (id: string) =>
      ((await editorRead(sb, w, runId, id, "variables")) as { text: string }).text;
    expect(await w.owner.browser.get("/v1/team/policy/agent-variable-values")).toMatchObject({
      status: 200,
      json: { site: false, team: null, effective: false },
    });
    const on = await w.owner.browser.put("/v1/team/policy/agent-variable-values", {
      enabled: true,
    });
    expect(on).toMatchObject({ status: 200, json: { site: false, team: true, effective: true } });
    const shown = await read("v1");
    expect(shown).toContain("- x: str (len 17) = 'sk-proj-TOKEN1234'");
    expect(shown).not.toContain("are withheld");
    // Credential-like names stay hidden even then.
    expect(shown).toContain("- api_key: str (len 32) = (value hidden: credential-like name)");
    const follow = await w.owner.browser.put("/v1/team/policy/agent-variable-values", {
      enabled: null,
    });
    expect(follow.json).toMatchObject({ team: null, effective: false });
    expect(await read("v2")).toContain("(value not shown to the agent)");
    expect(
      (await w.owner.browser.put("/v1/team/policy/agent-variable-values", { enabled: "yes" }))
        .status,
    ).toBe(400);
    expect(await audits(w.team, "policy.agent_variable_values.updated")).toEqual([
      { scope: "team", enabled: true },
      { scope: "team", enabled: null },
    ]);
  });

  it("the Site sets the default a team follows; only Site admins change it", async () => {
    const w = await world();
    expect(
      (await w.owner.browser.put("/v1/site/policy/agent-variable-values", { enabled: true }))
        .status,
    ).toBe(403);
    try {
      expect(
        await siteAdmin.browser.put("/v1/site/policy/agent-variable-values", { enabled: true }),
      ).toMatchObject({ status: 200, json: { enabled: true } });
      expect(
        (await w.owner.browser.get("/v1/team/policy/agent-variable-values")).json,
      ).toMatchObject({ site: true, team: null, effective: true });
      await w.owner.browser.put("/v1/team/policy/agent-variable-values", { enabled: false });
      expect(
        (await w.owner.browser.get("/v1/team/policy/agent-variable-values")).json,
      ).toMatchObject({ site: true, team: false, effective: false });
    } finally {
      await siteAdmin.browser.put("/v1/site/policy/agent-variable-values", { enabled: false });
    }
  });

  it("says variables are not available from an agent without notebook_inspect", async () => {
    const w = await world();
    const sb = await connected(w, [CAPABILITY_NOTEBOOKS]);
    const runId = await agentRun(w, "analysis.py");
    const vars = await editorRead(sb, w, runId, "v", "variables");
    expect(vars).toMatchObject({ ok: false, error: { code: "variables_unsupported" } });
  });
});

describe("concurrency with the member's Run (KOBE-848)", { timeout: 60_000 }, () => {
  it("refuses the member's Run while the agent works; the member's Stop interrupts the agent's run", async () => {
    const w = await world();
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sb = await connected(w, undefined, hold);
    await seed(w, "analysis.py", "while True: pass\n");
    const runId = await agentRun(w, "analysis.py");
    const input = { path: "analysis.py" };
    await check(sb, w, runId, "run-c", "editor_run", input);
    const pending = editorRun(sb, w, runId, "run-c", input);
    await sb.until(() => sb.frames("notebook.execute")[0], 15_000);
    const busy = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/run`, input);
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ code: "thread_busy" });
    const stop = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/interrupt`, {});
    expect(stop.status).toBe(200);
    expect(sb.frames("notebook.interrupt")).toHaveLength(1);
    release();
    expect(await pending).toMatchObject({ ok: true, status: "interrupted" });
    expect((await auditsN(w.team, "run.editor_run", 1)).map((t) => t.status)).toEqual([
      "interrupted",
    ]);
    must(sb.frames("notebook.execute")[0], "execute");
  });
});
