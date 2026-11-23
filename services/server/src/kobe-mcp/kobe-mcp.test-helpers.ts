// Shared setup for the kobe-mcp.*.db.test.ts files (split from kobe-mcp.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import {
  DEFAULT_LIMITS,
  FakeUpstream,
  NO_GRANTS,
  createApp as createProxyApp,
  createLimiter,
  createPolicyServer,
  createUpstreamClient,
  type UpstreamClient,
} from "@kobe/mcp-proxy";
import { KOBE_BUILTIN_CONNECTOR_ID, KOBE_MCP_MODE_KEY, seedKobeBuiltinConnector } from "@kobe/db";
import { approvalKeyring } from "../approvals/index.js";
import { createInternalApp } from "../routes/internal.js";
import { EventStreamFixture, type Person } from "../testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_VERIFY_KEYS,
  allowApproval,
  leaseRun,
  mcpToken,
} from "../testing/mcp-fixtures.js";

/**
 * The built-in Kobe MCP server end to end (KOBE-619, spec kobe-admin-mcp §3, §6–§8, KA-2 ac-1..6):
 * a sandbox calls the **real MCP proxy app**, which talks HTTP to the **real internal listener**;
 * the server decides (policy engine, Kobe admin guard, signed approvals over the `approvals` table,
 * audit) and executes the console route in process as the person, on a real Postgres. The sandbox
 * here is "tampered": it never sends `policy.check`, so only the proxy-side re-check stands.
 */
export const fx = new EventStreamFixture();
export const KEYRING = approvalKeyring("k".repeat(48));
export const live = new Set<string>();
export const upstreamServer = new FakeUpstream();
export let internal: ServerType;
export let upstream: UpstreamClient;
export let proxy: ReturnType<typeof createProxyApp>;
export let kobeName = "kobe";

export const setSite = async (key: string, value: string | null) => {
  if (value === null) await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [key]);
  else
    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
};
export const setLevel = (team: string, level: string | null) =>
  fx.admin.query(
    level === null
      ? `UPDATE teams SET settings = settings - 'kobe_mcp.admin' WHERE id = $1`
      : `UPDATE teams SET settings = settings || jsonb_build_object('kobe_mcp.admin', $2::text) WHERE id = $1`,
    level === null ? [team] : [team, level],
  );

export interface Sandbox {
  readonly team: string;
  readonly person: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
}

export interface World {
  readonly team: string;
  readonly admin: Person;
  readonly member: Person;
  readonly target: Person;
}

export async function world(level: string | null = "read_write"): Promise<World> {
  const admin = await fx.person(`ka${randomUUID().slice(0, 4)}`);
  const member = await fx.person(`km${randomUUID().slice(0, 4)}`);
  const target = await fx.person(`kt${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`kobe-${randomUUID().slice(0, 6)}`, admin, [member, target]);
  await setLevel(team, level);
  return { team, admin, member, target };
}

export async function sandboxFor(team: string, person: Person): Promise<Sandbox> {
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, person);
  const threadId = await leaseRun(fx.admin, team, runId, person.id, sandboxId);
  return {
    team,
    person,
    sandboxId,
    token: mcpToken({ sandboxId, teamId: team, userId: person.id }),
    runId,
    threadId,
  };
}

export let nextId = 1;
export async function rpc(
  s: Sandbox,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await proxy.request(`/v1/mcp/${KOBE_BUILTIN_CONNECTOR_ID}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${s.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "kobe-thread-id": s.threadId,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

export const listNames = async (s: Sandbox): Promise<string[]> => {
  const res = await rpc(s, "tools/list");
  if (res.status !== 200) return [`status:${res.status}`];
  return (res.json?.result.tools as { name: string }[]).map((t) => t.name).sort();
};

export async function call(
  s: Sandbox,
  name: string,
  args: Record<string, unknown>,
  toolCallId?: string,
): Promise<{ isError?: boolean; text: string; structured?: Record<string, unknown> }> {
  const res = await rpc(s, "tools/call", {
    name,
    arguments: args,
    ...(toolCallId ? { _meta: { "kobe.dev/tool_call_id": toolCallId } } : {}),
  });
  expect(res.status).toBe(200);
  const result = res.json?.result as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  return {
    ...(result.isError ? { isError: true } : {}),
    text: result.content[0]?.text ?? "",
    ...(result.structuredContent ? { structured: result.structuredContent } : {}),
  };
}

export const roleOf = async (team: string, userId: string) => {
  const { rows } = await fx.admin.query<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [team, userId],
  );
  return rows[0]?.role;
};

/** KOBE-620 (KA7): the docs tools are listed on every run while the site switch is not off. */
export const DOCS = ["docs_full", "docs_index", "docs_page", "docs_search"];
export const withDocs = (...names: string[]) => [...DOCS, ...names].sort();

export const pi = (tool: string) => `mcp__${kobeName.replace(/-/g, "_")}__${tool}`;

export const approve = (s: Sandbox, tool: string, input: Record<string, unknown>) =>
  allowApproval(fx.admin, {
    teamId: s.team,
    runId: s.runId,
    threadId: s.threadId,
    userId: s.person.id,
    tool: pi(tool),
    input: input as never,
    key: KEYRING.current,
  });

export const decisions = async (team: string) => {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'mcp.tool_call' ORDER BY seq`,
    [team],
  );
  return rows.map((r) => r.target);
};

/** Registers the shared hooks; call once at the top level of each kobe-mcp.*.db.test.ts file. */
export function useKobeMcpWorld(): void {
  beforeAll(async () => {
    await fx.setup([{}], () => ({ sandboxWire: { sweep: false }, approvalKeys: KEYRING }));
    const seeded = await seedKobeBuiltinConnector(fx.db);
    if (seeded.outcome === "names_taken") throw new Error("kobe names taken");
    kobeName = seeded.name;
    await upstreamServer.start();
    const app = createInternalApp({
      internalKey: INTERNAL_KEY,
      mcp: fx.replica(0).deps.mcp,
      kobe: fx.replica(0).deps.kobeMcp,
      auth: {
        db: fx.db,
        sessionVerifyKeys: MCP_VERIFY_KEYS,
        liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
      },
    });
    internal = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const { port } = internal.address() as AddressInfo;
    upstream = createUpstreamClient({
      policy: {
        allowInsecureHttp: true,
        allowedPorts: [],
        allowedInternalCidrs: [],
        deniedCidrs: [],
      },
      maxResponseBytes: 1024 * 1024,
    });
    proxy = createProxyApp({
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      server: createPolicyServer({
        baseUrl: `http://127.0.0.1:${port}`,
        internalKey: INTERNAL_KEY,
        timeoutMs: 10_000,
      }),
      upstream,
      credentials: NO_GRANTS,
      limiter: createLimiter({
        burst: 1_000,
        perSecond: 100,
        callsPerSandbox: 8,
        maxConcurrentCalls: 64,
      }),
      limits: { ...DEFAULT_LIMITS, upstreamTimeoutMs: 10_000 },
      log: pino({ level: "silent" }),
    });
  });

  afterAll(async () => {
    await upstream.close();
    await upstreamServer.stop();
    await new Promise<void>((resolve) => internal.close(() => resolve()));
    await fx.teardown();
  });

  beforeEach(async () => {
    await setSite(KOBE_MCP_MODE_KEY, "admin");
    await setSite("kobe_mcp.reads_per_minute", null);
    await setSite("kobe_mcp.writes_per_hour", null);
  });
}
