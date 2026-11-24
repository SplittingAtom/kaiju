import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "@kaiju/protocol";
import { approvalKeyring } from "../approvals/index.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";

/**
 * Tools the server runs itself, through a gated frame (KOBE-800): the server can't tell which of
 * the sandbox's runs issued a call (the sandbox names the run, and one sandbox hosts all of the
 * user's runs), so such a call is decided under every active run of the sandbox, as connector
 * calls are (KOBE-777): naming a permissive sibling run never gets a laxer decision than a
 * restrictive run would; where the runs disagree the member is asked, and the approval is signed
 * for the run, tool call and input actually named and executed.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];

beforeAll(async () => {
  await fx.setup([{}], () => ({
    approvalKeys: approvalKeyring("approval-key-for-tests-".padEnd(48, "g")),
    approvals: { pollMs: 100 },
    sandboxWire: { sweep: false, tuning: { batchWindowMs: 20, resultPollMs: 200 } },
  }));
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
});

/** Every gated frame kind's tool, with an input its schema accepts. */
const KINDS = [
  {
    frame: "artifact.put",
    tool: "create_artifact",
    input: { kind: "markdown", title: "Plan", content: "# x" },
  },
  { frame: "file.share", tool: "share_file", input: { path: "x.txt" } },
  {
    frame: "memory.put",
    tool: "remember",
    input: { scope: "user", path: "prefs.md", content: "likes tea" },
  },
  { frame: "memory.read", tool: "recall", input: { query: "tea" } },
  { frame: "memory.show", tool: "show_memory_item", input: { id: randomUUID() } },
  { frame: "project.commit", tool: "commit_project", input: { message: "m" } },
  {
    frame: "file.edit_propose",
    tool: "propose_file_edit",
    input: { path: "a.md", content: "b\n", summary: "b" },
  },
  { frame: "file.open", tool: "open_file", input: { path: "a.md" } },
  { frame: "notebook.run", tool: "run_python", input: { code: "print(1)" } },
  { frame: "skill.draft_save", tool: "save_skill_draft", input: { folder: "my-skill" } },
] as const;

/** Asked in ask-on-write without a rule: the permissive run gets a remembered approval for them. */
const ASKING = ["share_file", "commit_project"];

interface Run {
  readonly runId: string;
  readonly threadId: string;
}

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly sb: FakeSandbox;
  /** In a thread of an agent without tool lists: the run every call below names. */
  readonly permissive: Run;
  /** Starts a run of an agent whose tools.deny names every tool above, in the same sandbox. */
  restrictive(): Promise<Run>;
}

/** Creates and publishes a team agent as the owner, and pins the run (and its thread) to it. */
async function pin(team: string, owner: Person, run: Run, frontmatter: Record<string, unknown>) {
  const created = await owner.browser.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Agent ${randomBytes(2).toString("hex")}`, ...frontmatter },
    prompt: "Do it.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const published = await owner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  await fx.admin.query(
    `UPDATE threads SET agent_scope = 'team', agent_id = $2, agent_version = 1 WHERE id = $1`,
    [run.threadId, id],
  );
  await fx.admin.query(`UPDATE runs SET agent_version = 1 WHERE id = $1`, [run.runId]);
}

async function world(): Promise<World> {
  const owner = await fx.person(`g${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`gs-${randomBytes(3).toString("hex")}`, owner);
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    must(listeners[0], "listener").url,
    auth.issue({ sandboxId, teamId: team, userId: owner.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const startRun = async (frontmatter: Record<string, unknown>): Promise<Run> => {
    const runId = await fx.run(team, owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE id = $1`,
      [runId],
    );
    const run = { runId, threadId: must(rows[0], "run").thread_id };
    await pin(team, owner, run, frontmatter);
    const started = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: team, userId: owner.id },
        { runId, threadId: run.threadId, message: "hello" },
      );
    expect(started).toEqual({ ok: true });
    return run;
  };
  for (const tool of ASKING) {
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
       VALUES ($1, 'user', $2, 'allow', $3, $2, 'forever')`,
      [team, owner.id, tool],
    );
  }
  const permissive = await startRun({});
  const restrictive = () => startRun({ tools: { deny: KINDS.map((k) => k.tool) } });
  return { team, owner, sb, permissive, restrictive };
}

let nextRequest = 0;
function check(w: World, run: Run, tool: string, input: Record<string, unknown>) {
  const requestId = `r${(nextRequest += 1)}`;
  const toolCallId = `call-${requestId}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: run.runId,
    thread_id: run.threadId,
    tool_call_id: toolCallId,
    tool,
    input,
  });
  return {
    toolCallId,
    /** The first answer: `policy.pending` (the member is asked) or `policy.result`. */
    first: () =>
      w.sb.until(
        () =>
          w.sb.frames("policy.pending").find((f) => f.request_id === requestId) ??
          w.sb.frames("policy.result").find((f) => f.request_id === requestId),
      ),
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
  };
}

async function ruleApplied(w: World, run: Run, toolCallId: string): Promise<number> {
  const { rows } = await fx.admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM run_events
      WHERE team_id = $1 AND run_id = $2 AND type = 'policy.rule_applied'
        AND payload ->> 'tool_call_id' = $3`,
    [w.team, run.runId, toolCallId],
  );
  return Number(must(rows[0], "count").n);
}

describe("a server-run tool naming a permissive sibling run (KOBE-800)", () => {
  for (const kind of KINDS) {
    it(`${kind.frame} (${kind.tool}): no laxer decision than the restrictive run's`, async () => {
      const w = await world();
      // Alone, the permissive run allows the call outright.
      const alone = check(w, w.permissive, kind.tool, kind.input);
      const before = await alone.first();
      expect(before.type === "policy.result" && before.decision).toBe("allow");

      const strict = await w.restrictive();
      // The restrictive run itself refuses it.
      const own = await check(w, strict, kind.tool, kind.input).result();
      expect(own.decision === "deny" && own.reasons[0]?.code).toBe("agent_tool_deny");

      // Named under the permissive sibling, it is not allowed outright any more.
      const named = check(w, w.permissive, kind.tool, kind.input);
      const first = await named.first();
      if (kind.tool === "commit_project") {
        // CM6: the commit's own frame asks (over the server's input) instead of committing at once
        // by the remembered rule, which is neither claimed nor recorded.
        expect(first).toMatchObject({ type: "policy.result", decision: "allow" });
        expect(first.type === "policy.result" && first.reasons[0]?.code).toBe("agent_tool_deny");
        expect(await ruleApplied(w, w.permissive, named.toolCallId)).toBe(0);
        return;
      }
      expect(first.type).toBe("policy.pending");
      if (first.type !== "policy.pending") return;
      const denied = await w.owner.browser.post(`/v1/approvals/${first.approval_id}`, {
        decision: "deny",
      });
      expect(denied.status, JSON.stringify(denied.json)).toBe(200);
      expect((await named.result()).decision).toBe("deny");
    });
  }

  it("the member's approval is signed for the named run, tool call and exact input", async () => {
    const w = await world();
    await w.restrictive();
    const input = { scope: "user", path: "prefs.md", content: "likes tea" };
    const named = check(w, w.permissive, "remember", input);
    const first = await named.first();
    if (first.type !== "policy.pending") throw new Error("expected the member to be asked");
    const allowed = await w.owner.browser.post(`/v1/approvals/${first.approval_id}`, {
      decision: "allow",
    });
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
    expect((await named.result()).decision).toBe("allow");
    const { rows } = await fx.admin.query<{
      run_id: string;
      tool_call_id: string;
      tool: string;
      input_canonical: string;
      status: string;
    }>(`SELECT run_id, tool_call_id, tool, input_canonical, status FROM approvals WHERE id = $1`, [
      first.approval_id,
    ]);
    expect(rows[0]).toEqual({
      run_id: w.permissive.runId,
      tool_call_id: named.toolCallId,
      tool: "remember",
      input_canonical: canonicalJson(input),
      status: "allowed",
    });
  });

  it("once the restrictive run ends, the permissive run alone decides again", async () => {
    const w = await world();
    const strict = await w.restrictive();
    await fx.complete(w.team, strict.runId);
    const call = check(w, w.permissive, "create_artifact", {
      kind: "markdown",
      title: "Plan",
      content: "# x",
    });
    const first = await call.first();
    expect(first.type === "policy.result" && first.decision).toBe("allow");
  });
});
