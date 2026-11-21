import { EventEmitter } from "node:events";
import {
  CAPABILITY_ARTIFACTS,
  CAPABILITY_FILE_EDITS,
  CAPABILITY_FILES,
  CAPABILITY_MEMORY,
  CAPABILITY_NOTEBOOKS,
  CAPABILITY_PROJECTS,
  CAPABILITY_SEMANTIC_MEMORY,
  CAPABILITY_SKILL_DRAFTS,
  PI_PINNED_VERSION,
  SANDBOX_CLOSE_CODES,
  type ToolRegistry,
} from "@kobe/protocol";
import pino from "pino";
import type * as Db from "@kobe/db";
import type WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllowedArtifactCalls } from "../artifacts/allowed.js";
import type * as Commands from "./commands.js";
import { SandboxConnection } from "./connection.js";
import { WIRE_DEFAULTS } from "./constants.js";
import { newMetrics, type WireContext } from "./context.js";
import type { ConnectionRegistry } from "./registry.js";
import type * as RunState from "./run-state.js";

/**
 * Characterization of the tool-frame gate (KOBE-706): for every frame a tool sends, a refusal at
 * any stage of the gate (capability, run lease, compaction run, allowed call, in-flight cap)
 * answers the frame and never reaches the frame's action. "Reached" is observed on the action's
 * own dependencies (storage, memory, commits, drafts, notebooks, transactions), which are
 * recording proxies here, so removing any stage of the gate for any kind fails a test below.
 */

/** Anything an action does once past the gate: a dependency touched or a transaction opened. */
const reached: string[] = [];
let armed = false;
const hang = () => new Promise<never>(() => undefined);

vi.mock("@kobe/db", async (importOriginal) => {
  const orig = await importOriginal<typeof Db>();
  return {
    ...orig,
    withTeam: vi.fn((_db: unknown, _team: string, fn: (tx: unknown) => unknown) => {
      if (!armed) return Promise.resolve(fn({}));
      reached.push("withTeam");
      return hang();
    }),
  };
});
vi.mock("./run-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RunState>()),
  activeLeasedRuns: () => Promise.resolve([]),
}));
vi.mock("./commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Commands>()),
  orphanedDeliveries: () => Promise.resolve([]),
  pendingCommands: () => Promise.resolve([]),
}));

const silentLog = pino({ level: "silent" });

/** A dependency that records any use and never settles. `log` stays a silent logger. */
function recorder(name: string): unknown {
  const fn = function () {
    return undefined;
  };
  const proxy: unknown = new Proxy(fn, {
    get: (_t, key) => {
      // Compared as a number (a size cap) without throwing, so the action goes on to wait.
      if (key === Symbol.toPrimitive) return () => Number.MAX_SAFE_INTEGER;
      if (typeof key === "symbol" || key === "then") return undefined;
      if (key === "log") return silentLog;
      reached.push(`${name}.${key}`);
      return proxy;
    },
    apply: () => {
      reached.push(`${name}()`);
      return hang();
    },
  });
  return proxy;
}

const RUN = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN = "33333333-3333-4333-8333-333333333333";
const SANDBOX = "66666666-6666-4666-8666-666666666666";
const TEAM = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const SHA = "a".repeat(64);

interface Kind {
  readonly type: string;
  readonly result: string;
  readonly capabilities: readonly string[];
  readonly fields: Record<string, unknown>;
  /** Kinds with a per-connection in-flight cap answered `storage_failed`. */
  readonly capped: boolean;
}

const KINDS: readonly Kind[] = [
  {
    type: "artifact.put",
    result: "artifact.result",
    capabilities: [CAPABILITY_ARTIFACTS],
    fields: { tool: "create_artifact", input: { kind: "markdown", title: "Plan", content: "# x" } },
    capped: true,
  },
  {
    type: "file.share",
    result: "file.share_result",
    capabilities: [CAPABILITY_FILES],
    fields: {
      tool: "share_file",
      input: { path: "x.txt" },
      workspace: { path: "x.txt", rev: 1, sha256: SHA, size: 3 },
    },
    capped: true,
  },
  {
    type: "memory.put",
    result: "memory.result",
    capabilities: [CAPABILITY_MEMORY],
    fields: { input: { scope: "user", path: "prefs.md", content: "likes tea" } },
    capped: true,
  },
  {
    type: "memory.read",
    result: "memory.result",
    capabilities: [CAPABILITY_MEMORY],
    fields: { input: { query: "tea" } },
    capped: true,
  },
  {
    type: "memory.show",
    result: "memory.result",
    capabilities: [CAPABILITY_MEMORY, CAPABILITY_SEMANTIC_MEMORY],
    fields: { input: { id: OTHER_RUN } },
    capped: true,
  },
  {
    type: "project.commit",
    result: "project.commit_result",
    capabilities: [CAPABILITY_PROJECTS],
    fields: { tool: "commit_project", input: { message: "m" } },
    capped: false,
  },
  {
    type: "file.edit_propose",
    result: "file.edit_propose_result",
    capabilities: [CAPABILITY_FILE_EDITS],
    fields: { tool: "propose_file_edit", input: { path: "a.md", content: "b\n", summary: "b" } },
    capped: false,
  },
  {
    type: "file.open",
    result: "file.open_result",
    capabilities: [CAPABILITY_FILE_EDITS],
    fields: { tool: "open_file", input: { path: "a.md" } },
    capped: false,
  },
  {
    type: "notebook.run",
    result: "notebook.run_result",
    capabilities: [CAPABILITY_NOTEBOOKS],
    fields: { tool: "run_python", input: { code: "print(1)" } },
    capped: false,
  },
  {
    type: "skill.draft_save",
    result: "skill.draft_save_result",
    capabilities: [CAPABILITY_SKILL_DRAFTS],
    fields: {
      tool: "save_skill_draft",
      input: { folder: "my-skill" },
      files: [{ path: "my-skill/SKILL.md", rev: 1, sha256: SHA, size: 3 }],
    },
    capped: true,
  },
];

const ALL_CAPABILITIES = [...new Set(KINDS.flatMap((k) => k.capabilities))];

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  deliver(frame: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }
}

const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function harness() {
  const audits: { kind: string; reason: unknown }[] = [];
  const audit = (kind: string) => (_t: unknown, _s: unknown, refusal: { reason: unknown }) =>
    audits.push({ kind, reason: refusal.reason });
  const ctx = {
    db: recorder("db"),
    bus: { notify: () => Promise.resolve() },
    tuning: { ...WIRE_DEFAULTS, maxPendingArtifactPuts: 1 },
    replicaId: "r1",
    serverCalls: [],
    tools: {} as ToolRegistry,
    policy: recorder("policy"),
    artifacts: recorder("artifacts"),
    fileShare: recorder("fileShare"),
    memory: recorder("memory"),
    projectCommits: recorder("projectCommits"),
    skillDrafts: recorder("skillDrafts"),
    notebooks: recorder("notebooks"),
    ui: recorder("ui"),
    hooks: recorder("hooks"),
    liveness: { isLive: () => Promise.resolve(true) },
    verifyToken: () => {
      throw new Error("no renewals here");
    },
    metrics: newMetrics(),
    log: silentLog,
    auditViolation: (_t: unknown, _s: unknown, violation: unknown) =>
      audits.push({ kind: "violation", reason: violation }),
    auditArtifactRefused: audit("artifact"),
    auditFileShareRefused: audit("file.share"),
    auditSkillDraftRefused: audit("skill.draft"),
    auditMemoryRefused: audit("memory"),
    auditTokenRejected: () => undefined,
    auditLimit: () => undefined,
    localResult: () => undefined,
    runEnded: () => undefined,
    principalAllowed: () => Promise.resolve(true),
  } as unknown as WireContext;
  const registry = {
    register: () => Promise.resolve("registered"),
    unregister: () => Promise.resolve(),
    touch: () => Promise.resolve(true),
  } as unknown as ConnectionRegistry;
  const socket = new FakeSocket();
  const conn = new SandboxConnection(
    ctx,
    socket as unknown as WebSocket,
    { sandboxId: SANDBOX, teamId: TEAM, userId: USER, exp: Date.now() / 1000 + 900 },
    registry,
  );
  return { conn, socket, audits };
}

async function connected(capabilities: readonly string[]) {
  const h = harness();
  h.conn.start();
  h.socket.deliver({
    v: 1,
    type: "hello",
    sandbox_id: SANDBOX,
    agent_version: "test",
    pi_version: PI_PINNED_VERSION,
    runs: [],
    capabilities,
  });
  await tick();
  expect(h.conn.ready).toBe(true);
  h.conn.leaseRun(RUN, THREAD, 0);
  await tick();
  h.socket.sent.length = 0;
  armed = true;
  return h;
}

let seq = 0;
function frameOf(kind: Kind, runId = RUN): Record<string, unknown> {
  seq += 1;
  return {
    v: 1,
    type: kind.type,
    request_id: `r${seq}`,
    run_id: runId,
    thread_id: THREAD,
    tool_call_id: `c${seq}`,
    ...kind.fields,
  };
}

/** What the sandbox got back for one frame, and what the server recorded. */
function outcome(h: Awaited<ReturnType<typeof connected>>, kind: Kind) {
  const answers = h.socket.sent.filter((f) => f.type === kind.result);
  return {
    answers: answers.map(({ request_id: _r, ...rest }) => rest),
    errors: h.socket.sent.filter((f) => f.type === "error").map((f) => f.code),
    closed: h.socket.closedWith,
    audits: h.audits,
    executed: h.socket.sent.some((f) => f.type === "notebook.execute"),
    reached: [...reached],
  };
}

type Verdict = "ok" | "not_allowed" | "input_mismatch";
function verdict(v: Verdict) {
  vi.spyOn(AllowedArtifactCalls.prototype, "check").mockReturnValue(v);
  vi.spyOn(AllowedArtifactCalls.prototype, "consume").mockReturnValue(v);
  vi.spyOn(AllowedArtifactCalls.prototype, "ruleAllowed").mockReturnValue(true);
}

beforeEach(() => {
  reached.length = 0;
  armed = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(KINDS)("tool frame gate: $type", (kind) => {
  it("reaches its action when every stage of the gate passes (control)", async () => {
    verdict("ok");
    const h = await connected(ALL_CAPABILITIES);
    h.socket.deliver(frameOf(kind));
    await tick();
    const o = outcome(h, kind);
    expect(o.reached.length > 0 || o.executed).toBe(true);
    expect(o.closed).toBeUndefined();
  });

  it.each(kind.capabilities)("refuses without the %s capability", async (missing) => {
    verdict("ok");
    const h = await connected(ALL_CAPABILITIES.filter((c) => c !== missing));
    h.socket.deliver(frameOf(kind));
    await tick();
    const o = outcome(h, kind);
    expect(o.reached).toEqual([]);
    expect(o.executed).toBe(false);
    expect(o.answers).toHaveLength(1);
    expect(o.answers[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(o).toMatchSnapshot();
  });

  it("closes the connection for a run never leased here", async () => {
    verdict("ok");
    const h = await connected(ALL_CAPABILITIES);
    h.socket.deliver(frameOf(kind, OTHER_RUN));
    await tick();
    const o = outcome(h, kind);
    expect(o.reached).toEqual([]);
    expect(o.executed).toBe(false);
    expect(o.answers).toEqual([]);
    expect(o.closed).toBe(SANDBOX_CLOSE_CODES.lease_violation);
    expect(o.audits).toContainEqual({ kind: "violation", reason: "unknown_run" });
    expect(o).toMatchSnapshot();
  });

  it("refuses for a run that has ended", async () => {
    verdict("ok");
    const h = await connected(ALL_CAPABILITIES);
    h.conn.endLease(RUN);
    h.socket.deliver(frameOf(kind));
    await tick();
    const o = outcome(h, kind);
    expect(o.reached).toEqual([]);
    expect(o.executed).toBe(false);
    expect(o.answers).toHaveLength(1);
    expect(o.answers[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(o.errors).toEqual(["run_not_active"]);
    expect(o).toMatchSnapshot();
  });

  it("refuses for a compaction run (KOBE-213)", async () => {
    verdict("ok");
    const h = await connected(ALL_CAPABILITIES);
    h.conn.leaseRun(OTHER_RUN, THREAD, 0, true);
    h.socket.deliver(frameOf(kind, OTHER_RUN));
    await tick();
    const o = outcome(h, kind);
    expect(o.reached).toEqual([]);
    expect(o.executed).toBe(false);
    expect(o.answers[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(o.errors).toEqual(["run_not_active"]);
    expect(o).toMatchSnapshot();
  });

  it.each(["not_allowed", "input_mismatch"] as const)(
    "refuses a call the policy check did not allow (%s)",
    async (v) => {
      verdict(v);
      const h = await connected(ALL_CAPABILITIES);
      h.socket.deliver(frameOf(kind));
      await tick();
      const o = outcome(h, kind);
      expect(o.reached).toEqual([]);
      expect(o.executed).toBe(false);
      expect(o.answers).toHaveLength(1);
      expect(o.answers[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
      expect(o).toMatchSnapshot();
    },
  );

  it.runIf(kind.capped)("refuses past the in-flight cap without reaching the action", async () => {
    verdict("ok");
    const h = await connected(ALL_CAPABILITIES);
    h.socket.deliver(frameOf(kind));
    await tick(30); // the first action runs until it waits on a dependency
    expect(reached.length).toBeGreaterThan(0);
    reached.length = 0;
    h.socket.deliver(frameOf(kind));
    await tick();
    const o = outcome(h, kind);
    expect(o.reached).toEqual([]);
    expect(o.answers).toHaveLength(1);
    expect(o.answers[0]).toMatchObject({ ok: false, error: { code: "storage_failed" } });
    expect(o).toMatchSnapshot();
  });
});
