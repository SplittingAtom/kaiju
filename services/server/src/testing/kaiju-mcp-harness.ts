import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { pino } from "pino";
import {
  DEFAULT_LIMITS,
  FakeUpstream,
  NO_GRANTS,
  createApp as createProxyApp,
  createLimiter,
  createPolicyServer,
  createUpstreamClient,
  type UpstreamClient,
} from "@kaiju/mcp-proxy";
import {
  GIT_BUILTIN_CONNECTOR_ID,
  KAIJU_BUILTIN_CONNECTOR_ID,
  KAIJU_MCP_MODE_KEY,
  seedGitBuiltinConnector,
  seedKaijuBuiltinConnector,
} from "@kaiju/db";
import { approvalKeyring } from "../approvals/index.js";
import { routeCaller } from "../kaiju-mcp/execute.js";
import type { KaijuRouteCaller } from "../kaiju-mcp/catalog.js";
import type { ServerDepsOptions } from "../deps.js";
import { createInternalApp } from "../routes/internal.js";
import { EventStreamFixture, type Person } from "./event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_VERIFY_KEYS,
  allowApproval,
  leaseRun,
  mcpToken,
} from "./mcp-fixtures.js";

/**
 * The built-in Kaiju MCP server end to end for db tests (KOBE-619 setup, shared by KOBE-621): the
 * real MCP proxy app talks HTTP to the real internal listener; the server decides and executes
 * the console route in process as the person.
 */

export interface KaijuSandbox {
  readonly team: string;
  readonly person: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
}

export interface KaijuWorld {
  readonly team: string;
  readonly admin: Person;
  readonly member: Person;
  readonly target: Person;
}

export interface KaijuCallResult {
  readonly isError?: true;
  readonly text: string;
  readonly structured?: Record<string, unknown>;
}

export class KaijuMcpHarness {
  readonly fx = new EventStreamFixture();
  readonly keyring = approvalKeyring("k".repeat(48));
  private readonly live = new Set<string>();
  private readonly upstreamServer = new FakeUpstream();
  private internal: ServerType | undefined;
  private upstream: UpstreamClient | undefined;
  private proxy: ReturnType<typeof createProxyApp> | undefined;
  private kaijuName = "kobe";
  private gitName = "kaiju-git";
  /** Which built-in the calls below address (KOBE-762: the git connector is its own). */
  builtin: "kaiju" | "git" = "kaiju";
  private nextId = 1;

  /** `extra`: more server options (the git tools' envelope and host seam, KOBE-762). */
  async setup(extra: Partial<ServerDepsOptions> = {}): Promise<void> {
    const fx = this.fx;
    await fx.setup([{}], () => ({
      sandboxWire: { sweep: false },
      approvalKeys: this.keyring,
      ...extra,
    }));
    const seeded = await seedKaijuBuiltinConnector(fx.db);
    if (seeded.outcome === "names_taken") throw new Error("kaiju names taken");
    this.kaijuName = seeded.name;
    const git = await seedGitBuiltinConnector(fx.db);
    if (git.outcome === "names_taken") throw new Error("kaiju-git names taken");
    this.gitName = git.name;
    await this.upstreamServer.start();
    const app = createInternalApp({
      internalKey: INTERNAL_KEY,
      mcp: fx.replica(0).deps.mcp,
      kaiju: fx.replica(0).deps.kaijuMcp,
      gitMcp: fx.replica(0).deps.gitMcp,
      auth: {
        db: fx.db,
        sessionVerifyKeys: MCP_VERIFY_KEYS,
        liveness: { isLive: ({ sandboxId }) => Promise.resolve(this.live.has(sandboxId)) },
      },
    });
    this.internal = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const { port } = this.internal.address() as AddressInfo;
    this.upstream = createUpstreamClient({
      policy: {
        allowInsecureHttp: true,
        allowedPorts: [],
        allowedInternalCidrs: [],
        deniedCidrs: [],
      },
      maxResponseBytes: 1024 * 1024,
    });
    this.proxy = createProxyApp({
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      server: createPolicyServer({
        baseUrl: `http://127.0.0.1:${port}`,
        internalKey: INTERNAL_KEY,
        timeoutMs: 10_000,
      }),
      upstream: this.upstream,
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
  }

  async teardown(): Promise<void> {
    await this.upstream?.close();
    await this.upstreamServer.stop();
    const internal = this.internal;
    if (internal) await new Promise<void>((resolve) => internal.close(() => resolve()));
    await this.fx.teardown();
  }

  async setSite(key: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [key]);
      return;
    }
    await this.fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
  }

  async setLevel(team: string, level: string | null): Promise<void> {
    await this.fx.admin.query(
      level === null
        ? `UPDATE teams SET settings = settings - 'kaiju_mcp.admin' WHERE id = $1`
        : `UPDATE teams SET settings = settings || jsonb_build_object('kaiju_mcp.admin', $2::text) WHERE id = $1`,
      level === null ? [team] : [team, level],
    );
  }

  /** Admin tools on, default limits. */
  async reset(): Promise<void> {
    await this.setSite(KAIJU_MCP_MODE_KEY, "admin");
    await this.setSite("kaiju_mcp.reads_per_minute", null);
    await this.setSite("kaiju_mcp.writes_per_hour", null);
  }

  async world(level: string | null = "read_write"): Promise<KaijuWorld> {
    const fx = this.fx;
    const admin = await fx.person(`ka${randomUUID().slice(0, 4)}`);
    const member = await fx.person(`km${randomUUID().slice(0, 4)}`);
    const target = await fx.person(`kt${randomUUID().slice(0, 4)}`);
    const team = await fx.team(`kaiju-${randomUUID().slice(0, 6)}`, admin, [member, target]);
    await this.setLevel(team, level);
    return { team, admin, member, target };
  }

  async sandboxFor(team: string, person: Person): Promise<KaijuSandbox> {
    const sandboxId = randomUUID();
    this.live.add(sandboxId);
    const runId = await this.fx.run(team, person);
    const threadId = await leaseRun(this.fx.admin, team, runId, person.id, sandboxId);
    return {
      team,
      person,
      sandboxId,
      token: mcpToken({ sandboxId, teamId: team, userId: person.id }),
      runId,
      threadId,
    };
  }

  /** The console routes as the person, through a delegation of their own active run. */
  async routesAs(team: string, person: Person): Promise<KaijuRouteCaller> {
    const s = await this.sandboxFor(team, person);
    return routeCaller(this.fx.replica(0).app, {
      userId: person.id,
      teamId: team,
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "contract",
    });
  }

  async rpc(s: KaijuSandbox, method: string, params?: Record<string, unknown>) {
    if (!this.proxy) throw new Error("harness not set up");
    const connector =
      this.builtin === "git" ? GIT_BUILTIN_CONNECTOR_ID : KAIJU_BUILTIN_CONNECTOR_ID;
    const res = await this.proxy.request(`/v1/mcp/${connector}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "kaiju-thread-id": s.threadId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        ...(params ? { params } : {}),
      }),
    });
    const text = await res.text();
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
  }

  async listNames(s: KaijuSandbox): Promise<string[]> {
    const res = await this.rpc(s, "tools/list");
    if (res.status !== 200) return [`status:${res.status}`];
    const result = res.json?.result as { tools: { name: string }[] };
    return result.tools.map((t) => t.name).sort();
  }

  async call(
    s: KaijuSandbox,
    name: string,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<KaijuCallResult> {
    const res = await this.rpc(s, "tools/call", {
      name,
      arguments: args,
      ...(toolCallId ? { _meta: { "kobe.dev/tool_call_id": toolCallId } } : {}),
    });
    if (res.status !== 200) throw new Error(`tools/call answered ${res.status}`);
    const result = res.json?.result as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    return {
      ...(result.isError ? { isError: true as const } : {}),
      text: result.content[0]?.text ?? "",
      ...(result.structuredContent ? { structured: result.structuredContent } : {}),
    };
  }

  pi(tool: string): string {
    const name = this.builtin === "git" ? this.gitName : this.kaijuName;
    return `mcp__${name.replace(/-/g, "_")}__${tool}`;
  }

  approve(s: KaijuSandbox, tool: string, input: Record<string, unknown>) {
    return allowApproval(this.fx.admin, {
      teamId: s.team,
      runId: s.runId,
      threadId: s.threadId,
      userId: s.person.id,
      tool: this.pi(tool),
      input: input as never,
      key: this.keyring.current,
    });
  }

  /** Approves `input` and calls the tool with that approval's tool call id. */
  async approvedCall(s: KaijuSandbox, tool: string, input: Record<string, unknown>) {
    const approval = await this.approve(s, tool, input);
    return { approval, out: await this.call(s, tool, input, approval.toolCallId) };
  }
}
