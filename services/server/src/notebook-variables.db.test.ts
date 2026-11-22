import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOK_INSPECT,
  CAPABILITY_NOTEBOOKS,
  notebookRunResponseSchema,
  notebookVariablesResultSchema,
  type PolicyEngine,
} from "@kobe/protocol";
import { type SandboxToServerFrame, type ServerToSandboxFrame } from "@kobe/protocol/sandbox-wire";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { createWorkspaceSync, workspaceBlobKey } from "./workspace-sync/index.js";
import type { SandboxRouter } from "./sandbox-wire/types.js";
import { VARIABLES_RATE_LIMIT } from "./notebooks/variables.js";
import { hitRateLimit } from "./rate-limit.js";

/**
 * KOBE-803 end to end against a fake sandbox: `POST /v1/threads/{id}/notebook/variables` (a
 * silent `notebook.inspect`, decided like a Run, never waking the sandbox, only to agents with
 * `notebook_inspect`), and the run log on `notebook.finished` (timing and the snapshot from new
 * agents, the error read from the outputs; nothing new asked of older agents).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 4 * 1024 * 1024, maxWorkspaceBytes: 16 * 1024 * 1024, maxFiles: 50 };
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;
let sync: ReturnType<typeof createWorkspaceSync>;

const allowAll: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "destructive" as const,
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
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly reader: Person;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly token: string;
}

async function world(evalThread = false): Promise<World> {
  const owner = await fx.person(`v${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`nbv-${randomBytes(3).toString("hex")}`, owner, [reader]);
  const threadId = randomUUID();
  await fx.admin.query(
    `INSERT INTO threads (id, team_id, owner_user_id, title, skill_eval)
     VALUES ($1, $2, $3, 'nb', $4)`,
    [threadId, team, owner.id, evalThread],
  );
  const sandboxId = randomUUID();
  return {
    team,
    owner,
    reader,
    threadId,
    sandboxId,
    token: auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  };
}

const SNAPSHOT = {
  status: "ok",
  taken_at: "2026-11-22T10:00:01.000Z",
  execution_count: 7,
  variables: [
    {
      name: "df",
      type: "DataFrame",
      module: "pandas",
      repr: "DataFrame: 2 rows × 1 columns",
      shape: [2, 1],
    },
  ],
  other: [{ name: "pd", kind: "module" }],
  truncated: false,
};
const TIMING = {
  started_at: "2026-11-22T10:00:00.000Z",
  finished_at: "2026-11-22T10:00:00.750Z",
  duration_ms: 750,
};

type ExecuteFrame = Extract<ServerToSandboxFrame, { type: "notebook.execute" }>;
type InspectFrame = Extract<ServerToSandboxFrame, { type: "notebook.inspect" }>;

const NEW_AGENT = [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT];

/**
 * A sandbox answering `notebook.inspect` with `inspect(frame)` and running each
 * `notebook.execute` as a ZeroDivisionError on line 2 (with timing when asked, plus `extra`).
 */
async function connected(
  w: World,
  capabilities: readonly string[] = NEW_AGENT,
  inspect: (frame: InspectFrame) => unknown = () => SNAPSHOT,
  extra: Record<string, unknown> = {},
) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.respond = (frame): SandboxToServerFrame | undefined => {
    if (frame.type === "notebook.inspect") {
      return {
        v: 1,
        type: "command.result",
        command_id: frame.command_id,
        ok: true,
        data: inspect(frame),
      } as SandboxToServerFrame;
    }
    if (frame.type !== "notebook.execute") return undefined;
    sb.send({
      v: 1,
      type: "notebook.output",
      command_id: frame.command_id,
      thread_id: frame.thread_id,
      index: 0,
      output: {
        output_type: "error",
        ename: "ZeroDivisionError",
        evalue: "division by zero",
        traceback: [
          "Cell In[7], line 2\n      1 x = 1\n----> 2 1 / 0\n",
          "ZeroDivisionError: division by zero",
        ],
      },
    });
    const asked = frame as ExecuteFrame;
    return {
      v: 1,
      type: "command.result",
      command_id: frame.command_id,
      ok: true,
      data: {
        status: "error",
        execution_count: 7,
        outputs: 1,
        truncated: false,
        ...(asked.with_timing === true ? { timing: TIMING } : {}),
        ...extra,
      },
    } as SandboxToServerFrame;
  };
  sb.hello(w.sandboxId, [], undefined, capabilities);
  await sb.ready();
  return sb;
}

const variables = (w: World, who: Person = w.owner, threadId = w.threadId) =>
  who.browser.post(`/v1/threads/${threadId}/notebook/variables`, {});

const router = () => fx.replica(0).deps.sandboxWire.router as SandboxRouter & { wake: unknown };

/** Runs `fn` with the router's wake replaced by a counter. */
async function counted<T>(fn: (wakes: () => number) => Promise<T>): Promise<T> {
  let count = 0;
  router().wake = () => {
    count += 1;
    return Promise.resolve();
  };
  try {
    return await fn(() => count);
  } finally {
    delete (router() as { wake?: unknown }).wake;
  }
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

async function finished(w: World, runId: string) {
  const { rows } = await fx.admin.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'notebook.finished'`,
    [w.team, runId],
  );
  return must(rows[0], "notebook.finished").payload;
}

async function runPy(w: World) {
  await seed(w, "job.py", "x = 1\n1 / 0\n");
  const res = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/run`, {
    path: "job.py",
  });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const ids = notebookRunResponseSchema.parse(res.json);
  await fx.replica(0).deps.runs.idle();
  return ids;
}

describe("POST /v1/threads/{id}/notebook/variables (KOBE-803)", () => {
  it("answers the kernel's snapshot from a connected sandbox; no run, no event", async () => {
    const w = await world();
    const sb = await connected(w);
    const res = await variables(w);
    expect([res.status, res.json]).toEqual([200, SNAPSHOT]);
    expect(notebookVariablesResultSchema.safeParse(res.json).success).toBe(true);
    expect(sb.frames("notebook.inspect")).toMatchObject([
      { thread_id: w.threadId, timeout_ms: 5000 },
    ]);
    expect(sb.frames("notebook.inspect")[0]).not.toHaveProperty("refresh");
    expect(sb.frames("notebook.execute")).toEqual([]);
    const runs = await fx.admin.query(`SELECT 1 FROM runs WHERE team_id = $1`, [w.team]);
    expect(runs.rowCount).toBe(0);
    const events = await fx.admin.query(`SELECT 1 FROM run_events WHERE team_id = $1`, [w.team]);
    expect(events.rowCount).toBe(0);
    // The answer's row is gone once the route read it (it holds reprs in plaintext).
    const rows = await fx.admin.query(`SELECT 1 FROM sandbox_commands WHERE team_id = $1`, [
      w.team,
    ]);
    expect(rows.rowCount).toBe(0);
    // Refresh asks the agent for a fresh one; anything else in the body is refused.
    const refreshed = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/variables`, {
      refresh: true,
    });
    expect([refreshed.status, refreshed.json]).toEqual([200, SNAPSHOT]);
    expect(sb.frames("notebook.inspect")[1]).toMatchObject({ refresh: true });
    const odd = await w.owner.browser.post(`/v1/threads/${w.threadId}/notebook/variables`, {
      code: "x",
    });
    expect(odd.status).toBe(400);
    expect(sb.frames("notebook.inspect")).toHaveLength(2);
  });

  it("passes busy and unavailable through, and an unreadable answer is unavailable", async () => {
    const w = await world();
    let answer: unknown = { status: "busy" };
    await connected(w, NEW_AGENT, () => answer);
    expect((await variables(w)).json).toEqual({ status: "busy" });
    answer = { status: "unavailable" };
    expect((await variables(w)).json).toEqual({ status: "unavailable" });
    answer = { ...SNAPSHOT, variables: [{ name: "x" }] };
    const odd = await variables(w);
    expect([odd.status, odd.json]).toEqual([200, { status: "unavailable" }]);
  });

  it("purges an unread snapshot within a minute (its requester is gone)", async () => {
    const w = await world();
    const insert = (kind: string) =>
      fx.admin.query(
        `INSERT INTO sandbox_commands (team_id, user_id, thread_id, kind, frame, status,
                                       connection_id, requester_replica, result, completed_at,
                                       expires_at)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, 'done', gen_random_uuid(), 'gone',
                 '{"ok":true}'::jsonb, now() - interval '2 minutes', now())`,
        [w.team, w.owner.id, w.threadId, kind],
      );
    await insert("notebook.inspect");
    await insert("pi.command");
    await fx.replica(0).deps.sandboxWire.sweep();
    const left = await fx.admin.query<{ kind: string }>(
      `SELECT kind FROM sandbox_commands WHERE team_id = $1`,
      [w.team],
    );
    expect(left.rows).toEqual([{ kind: "pi.command" }]);
  });

  it("passes a paused automatic snapshot's reason through", async () => {
    const w = await world();
    await connected(w, NEW_AGENT, () => ({
      status: "unavailable",
      auto_paused: "snapshot_timeout",
    }));
    const res = await variables(w);
    expect([res.status, res.json]).toEqual([
      200,
      { status: "unavailable", auto_paused: "snapshot_timeout" },
    ]);
  });

  it("never wakes a sandbox that is not connected: no_kernel", async () => {
    const w = await world();
    await counted(async (wakes) => {
      const res = await variables(w);
      expect([res.status, res.json]).toEqual([200, { status: "no_kernel" }]);
      // The router itself never wakes for it either (a check-then-send race lands here).
      const outcome = await router().notebookInspect(
        { teamId: w.team, userId: w.owner.id },
        { threadId: w.threadId, timeoutMs: 5000 },
      );
      expect(outcome).toMatchObject({ ok: false, error: { code: "sandbox_not_connected" } });
      expect(wakes()).toBe(0);
    });
  });

  it("an older agent is never sent the frame: variables_unsupported", async () => {
    const w = await world();
    const sb = await connected(w, [CAPABILITY_NOTEBOOKS]);
    const res = await variables(w);
    expect([res.status, (res.json as { code?: string }).code]).toEqual([
      409,
      "variables_unsupported",
    ]);
    expect(sb.frames("notebook.inspect")).toEqual([]);
    const none = await world();
    const bare = await connected(none, [CAPABILITY_NOTEBOOK_INSPECT]);
    const refused = await variables(none);
    expect([refused.status, (refused.json as { code?: string }).code]).toEqual([
      409,
      "notebooks_unsupported",
    ]);
    expect(bare.frames("notebook.inspect")).toEqual([]);
  });

  it("is the owner's only, refuses an eval thread, and is rate limited", async () => {
    const w = await world();
    const sb = await connected(w);
    await fx.activate(w.reader, w.team);
    expect((await variables(w, w.reader)).status).toBe(404);
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    const shared = await variables(w, w.reader);
    expect([shared.status, (shared.json as { code?: string }).code]).toEqual([403, "read_only"]);
    expect((await variables(w, w.owner, randomUUID())).status).toBe(404);
    expect(sb.frames("notebook.inspect")).toEqual([]);

    const evalWorld = await world(true);
    await counted(async (wakes) => {
      const res = await variables(evalWorld);
      expect([res.status, (res.json as { code?: string }).code]).toEqual([
        409,
        "skill_eval_thread",
      ]);
      expect(wakes()).toBe(0);
    });

    for (let i = 0; i < VARIABLES_RATE_LIMIT.max; i++) {
      await hitRateLimit(fx.db, `notebook-variables:${w.owner.id}`, VARIABLES_RATE_LIMIT);
    }
    const limited = await variables(w);
    expect([limited.status, (limited.json as { code?: string }).code]).toEqual([
      429,
      "rate_limited",
    ]);
  });
});

describe("the run log on notebook.finished (KOBE-803)", () => {
  it("a member's run asks a new agent for timing and a kept snapshot; the event logs timing and error, never variables", async () => {
    const w = await world();
    const sb = await connected(w);
    const { run_id } = await runPy(w);
    expect(sb.frames("notebook.execute")).toMatchObject([
      { with_timing: true, with_variables: true },
    ]);
    expect(await finished(w, run_id)).toMatchObject({
      status: "error",
      execution_count: 7,
      truncated: false,
      timing: TIMING,
      error: { name: "ZeroDivisionError", line: 2 },
    });
    expect(await finished(w, run_id)).not.toHaveProperty("variables");
    const { rows } = await fx.admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'notebook.started'`,
      [w.team, run_id],
    );
    expect(must(rows[0], "notebook.started").payload).toMatchObject({
      origin: "user",
      path: "job.py",
    });
  });

  it("an older agent is asked for neither, and its run still logs status and the error", async () => {
    const w = await world();
    const sb = await connected(w, [CAPABILITY_NOTEBOOKS]);
    const { run_id } = await runPy(w);
    const sent = must(sb.frames("notebook.execute")[0], "execute");
    expect(sent).not.toHaveProperty("with_timing");
    expect(sent).not.toHaveProperty("with_variables");
    const payload = await finished(w, run_id);
    expect(payload).toMatchObject({
      status: "error",
      error: { name: "ZeroDivisionError", line: 2 },
    });
    expect(payload).not.toHaveProperty("timing");
    expect(payload).not.toHaveProperty("variables");
  });

  it("a newer agent's unknown field or a malformed timing is dropped; the execution stands", async () => {
    const w = await world();
    await connected(w, NEW_AGENT, () => SNAPSHOT, {
      cpu_ms: 12,
      variables: SNAPSHOT,
      timing: { ...TIMING, duration_ms: -1 },
    });
    const { run_id } = await runPy(w);
    const payload = await finished(w, run_id);
    expect(payload).toMatchObject({
      status: "error",
      execution_count: 7,
      outputs: 1,
      error: { name: "ZeroDivisionError", line: 2 },
    });
    expect(payload).not.toHaveProperty("timing");
    expect(payload).not.toHaveProperty("variables");
    expect(payload).not.toHaveProperty("cpu_ms");
  });
});
