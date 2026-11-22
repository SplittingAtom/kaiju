import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_NOTEBOOK_COMPLETE,
  CAPABILITY_NOTEBOOK_INSPECT,
  CAPABILITY_NOTEBOOKS,
  notebookCompletionResultSchema,
  type PolicyEngine,
} from "@kobe/protocol";
import { type SandboxToServerFrame, type ServerToSandboxFrame } from "@kobe/protocol/sandbox-wire";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import type { SandboxRouter } from "./sandbox-wire/types.js";
import { COMPLETION_RATE_LIMIT } from "./notebooks/completion.js";
import { hitRateLimit } from "./rate-limit.js";

/**
 * KOBE-808 end to end against a fake sandbox: `POST /v1/threads/{id}/notebook/complete` (a
 * `notebook.inspect` with `op`, decided like the variables snapshot, never waking the sandbox,
 * only to agents with `notebook_complete`, rate limited, nothing stored).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

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
  const owner = await fx.person(`c${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`nbc-${randomBytes(3).toString("hex")}`, owner, [reader]);
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

const MATCHES = {
  status: "ok",
  op: "complete",
  matches: [{ text: "alpha", type: "attribute" }, { text: "beta" }],
  cursor_start: 3,
  cursor_end: 3,
};
const DOC = { status: "ok", op: "doc", found: true, signature: "head(n=5)", doc: "First rows." };

type InspectFrame = Extract<ServerToSandboxFrame, { type: "notebook.inspect" }>;
const NEW_AGENT = [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT, CAPABILITY_NOTEBOOK_COMPLETE];

/** A sandbox answering `notebook.inspect` with `answer(frame)` (undefined: never answers). */
async function connected(
  w: World,
  capabilities: readonly string[] = NEW_AGENT,
  answer: (frame: InspectFrame) => unknown = (f) => ("op" in f && f.op === "doc" ? DOC : MATCHES),
) {
  const sb = await FakeSandbox.connect(listener.url, w.token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.respond = (frame): SandboxToServerFrame | undefined => {
    if (frame.type !== "notebook.inspect") return undefined;
    const data = answer(frame);
    if (data === undefined) return undefined;
    return { v: 1, type: "command.result", command_id: frame.command_id, ok: true, data };
  };
  sb.hello(w.sandboxId, [], undefined, capabilities);
  await sb.ready();
  return sb;
}

const COMPLETE = { op: "complete", code: "df.", cursor: 3 };
const complete = (w: World, body: unknown = COMPLETE, who: Person = w.owner, id = w.threadId) =>
  who.browser.post(`/v1/threads/${id}/notebook/complete`, body);

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

const code = (res: { json: unknown }) => (res.json as { code?: string }).code;

const auditCount = async (w: World) =>
  (await fx.admin.query(`SELECT 1 FROM audit_log WHERE team_id = $1`, [w.team])).rowCount;

/** No run, event or command row; the audit log no longer than `audited` (set up's own rows). */
async function nothingStored(w: World, audited: number | null) {
  for (const table of ["runs", "run_events", "sandbox_commands"]) {
    const rows = await fx.admin.query(`SELECT 1 FROM ${table} WHERE team_id = $1`, [w.team]);
    expect(rows.rowCount, table).toBe(0);
  }
  expect(await auditCount(w)).toBe(audited);
}

describe("POST /v1/threads/{id}/notebook/complete (KOBE-808)", () => {
  it("answers the kernel's completions and docs; no run, no event, no row left", async () => {
    const w = await world();
    const sb = await connected(w);
    const audited = await auditCount(w);
    const res = await complete(w);
    expect([res.status, res.json]).toEqual([200, MATCHES]);
    expect(notebookCompletionResultSchema.safeParse(res.json).success).toBe(true);
    expect(sb.frames("notebook.inspect")).toMatchObject([
      { thread_id: w.threadId, op: "complete", code: "df.", cursor: 3, timeout_ms: 1000 },
    ]);
    const doc = await complete(w, { op: "doc", name: "df.head" });
    expect([doc.status, doc.json]).toEqual([200, DOC]);
    expect(sb.frames("notebook.inspect")[1]).toMatchObject({ op: "doc", name: "df.head" });
    expect(sb.frames("notebook.inspect")[1]).not.toHaveProperty("code");
    expect(sb.frames("notebook.execute")).toEqual([]);
    await nothingStored(w, audited);
  });

  it("refuses bodies that are not a completion or a dotted name, sending nothing", async () => {
    const w = await world();
    const sb = await connected(w);
    for (const body of [
      {},
      { op: "complete", code: "x", cursor: 5 },
      { op: "doc", name: "os.system('x')" },
      { op: "doc", name: "x", code: "x" },
      { op: "complete", code: "x".repeat(40_000), cursor: 1 },
    ]) {
      const res = await complete(w, body);
      expect([res.status, code(res)], JSON.stringify(body).slice(0, 60)).toEqual([
        400,
        "invalid_request",
      ]);
    }
    expect(sb.frames("notebook.inspect")).toEqual([]);
  });

  it("passes busy, no_kernel and unavailable through; a malformed or mismatched answer is unavailable", async () => {
    const w = await world();
    let answer: unknown = { status: "busy" };
    await connected(w, NEW_AGENT, () => answer);
    expect((await complete(w)).json).toEqual({ status: "busy" });
    answer = { status: "no_kernel" };
    expect((await complete(w)).json).toEqual({ status: "no_kernel" });
    answer = { status: "unavailable" };
    expect((await complete(w)).json).toEqual({ status: "unavailable" });
    answer = { ...MATCHES, matches: [{ text: "" }] };
    expect((await complete(w)).json).toEqual({ status: "unavailable" });
    answer = DOC;
    expect((await complete(w)).json).toEqual({ status: "unavailable" });
  });

  it("gives up after about a second when the kernel does not answer: unavailable", async () => {
    const w = await world();
    await connected(w, NEW_AGENT, () => undefined);
    const audited = await auditCount(w);
    const started = Date.now();
    const res = await complete(w);
    expect([res.status, res.json]).toEqual([200, { status: "unavailable" }]);
    expect(Date.now() - started).toBeLessThan(3_000);
    await nothingStored(w, audited);
  });

  it("never wakes a sandbox that is not connected: asleep", async () => {
    const w = await world();
    await counted(async (wakes) => {
      const res = await complete(w);
      expect([res.status, res.json]).toEqual([200, { status: "asleep" }]);
      // The router itself never wakes for it either (a check-then-send race lands here).
      const outcome = await router().notebookComplete(
        { teamId: w.team, userId: w.owner.id },
        { threadId: w.threadId, timeoutMs: 1000, op: "complete", code: "x", cursor: 1 },
      );
      expect(outcome).toMatchObject({ ok: false, error: { code: "sandbox_not_connected" } });
      expect(wakes()).toBe(0);
    });
  });

  it("an older agent is never sent the frame: unsupported", async () => {
    const w = await world();
    const sb = await connected(w, [CAPABILITY_NOTEBOOKS, CAPABILITY_NOTEBOOK_INSPECT]);
    expect((await complete(w)).json).toEqual({ status: "unsupported" });
    expect(sb.frames("notebook.inspect")).toEqual([]);
    const none = await world();
    const bare = await connected(none, [CAPABILITY_NOTEBOOK_COMPLETE]);
    expect((await complete(none)).json).toEqual({ status: "unsupported" });
    expect(bare.frames("notebook.inspect")).toEqual([]);
  });

  it("is the owner's only, refuses an eval thread, and is rate limited per member", async () => {
    const w = await world();
    const sb = await connected(w);
    await fx.activate(w.reader, w.team);
    expect((await complete(w, COMPLETE, w.reader)).status).toBe(404);
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    const shared = await complete(w, COMPLETE, w.reader);
    expect([shared.status, code(shared)]).toEqual([403, "read_only"]);
    expect((await complete(w, COMPLETE, w.owner, randomUUID())).status).toBe(404);
    expect(sb.frames("notebook.inspect")).toEqual([]);

    const evalWorld = await world(true);
    await counted(async (wakes) => {
      const res = await complete(evalWorld);
      expect([res.status, code(res)]).toEqual([409, "skill_eval_thread"]);
      expect(wakes()).toBe(0);
    });

    expect(COMPLETION_RATE_LIMIT).toEqual({ windowMs: 60_000, max: 600 });
    for (let i = 0; i < COMPLETION_RATE_LIMIT.max; i++) {
      await hitRateLimit(fx.db, `notebook-complete:${w.owner.id}`, COMPLETION_RATE_LIMIT);
    }
    const limited = await complete(w);
    expect([limited.status, code(limited)]).toEqual([429, "rate_limited"]);
    expect(sb.frames("notebook.inspect")).toEqual([]);
  });
});
