import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type KaijuDatabase } from "@kaiju/db";
import { approvalKeyring } from "../approvals/index.js";
import { createPolicyEngine } from "./engine.js";
import { createDbRuleSource, createDbSettingsSource } from "./rule-store.js";
import { EventStreamFixture, must, type Person } from "../testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "../testing/fake-sandbox.js";

/**
 * KOBE-831 (coordinator decision): published agent versions keep the tool manifest they were
 * frozen with, so versions from before the rename still say `source`/`scope` `kobe` for Kaiju's
 * own tools. The server maps them when it reads a manifest (`withCurrentNames`): a run on such a
 * version still gets Kaiju's own tools (a manifest that does not parse would deny every call),
 * and its version history still reads.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KaijuDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "m"));

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
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
  readonly agentId: string;
}

/**
 * A running `ask-on-write` run pinned to version 1 of a published team agent whose stored
 * manifest is rewritten to `stored(manifest)` (as a version frozen before the rename would be).
 */
async function world(stored: (manifestText: string) => string): Promise<World> {
  const owner = await fx.person(`m${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`pm-${randomBytes(3).toString("hex")}`, owner);
  const created = await owner.browser.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Agent ${randomBytes(2).toString("hex")}` },
    prompt: "Do it.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const agentId = created.json.agent.id as string;
  const published = await owner.browser.request(
    "POST",
    `/v1/agents/${agentId}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  const { rows } = await fx.admin.query<{ m: unknown }>(
    `SELECT tool_manifest AS m FROM team_agent_versions WHERE agent_id = $1 AND version = 1`,
    [agentId],
  );
  const current = JSON.stringify(must(rows[0], "version").m);
  expect(current).toContain('"source":"kaiju"');
  // Versions are immutable: the trigger is lifted for this fixture only.
  await fx.admin.query(
    `BEGIN;
     ALTER TABLE team_agent_versions DISABLE TRIGGER team_agent_versions_immutable;
     UPDATE team_agent_versions SET tool_manifest = '${stored(current).replaceAll("'", "''")}'::jsonb
      WHERE agent_id = '${agentId}' AND version = 1;
     ALTER TABLE team_agent_versions ENABLE TRIGGER team_agent_versions_immutable;
     COMMIT;`,
  );

  const runId = await fx.run(team, owner);
  const thread = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  const threadId = must(thread.rows[0], "run").thread_id;
  await fx.admin.query(
    `UPDATE threads SET agent_scope = 'team', agent_id = $2, agent_version = 1 WHERE id = $1`,
    [threadId, agentId],
  );
  await fx.admin.query(
    `UPDATE runs SET agent_version = 1, approval_mode = 'ask-on-write' WHERE id = $1`,
    [runId],
  );
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId);
  await sb.ready();
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { team, owner, runId, threadId, sb, agentId };
}

let nextRequest = 0;
async function decide(w: World, tool: string, input: Record<string, unknown>) {
  const requestId = `r${(nextRequest += 1)}`;
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
  return w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId));
}

const ARTIFACT = { kind: "markdown", title: "Notes", content: "# Notes" };

describe("a version frozen before the rename (KOBE-831)", () => {
  it("still gets Kaiju's own tools: source and scope kobe read as kaiju", async () => {
    const w = await world((m) =>
      m
        .replaceAll('"source":"kaiju"', '"source":"kobe"')
        .replaceAll('"scope":"kaiju"', '"scope":"kobe"'),
    );
    // Prompt-exempt Kaiju tools (artifacts) run without asking in ask-on-write.
    const artifact = await decide(w, "create_artifact", ARTIFACT);
    expect(artifact.decision, JSON.stringify(artifact)).toBe("allow");
    const one = await w.owner.browser.get(`/v1/agents/${w.agentId}/versions/1`);
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    const tools = one.json.version.toolManifest.tools as { name: string; source: string }[];
    expect(tools.find((t) => t.name === "create_artifact")?.source).toBe("kaiju");
    expect(tools.some((t) => t.source === "kobe")).toBe(false);
  });

  it("control: a manifest that does not parse fails closed (every call denied)", async () => {
    const w = await world((m) => m.replaceAll('"source":"kaiju"', '"source":"unknown"'));
    const artifact = await decide(w, "create_artifact", ARTIFACT);
    expect(artifact.decision).toBe("deny");
  });
});
