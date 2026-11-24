// Shared setup for the mcp.*.db.test.ts files (split from mcp.db.test.ts, KOBE-725).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import type { PinnedTool } from "@kaiju/db";
import { canonicalJson, type JsonObject } from "@kaiju/protocol";
import { approvalKeyring } from "../approvals/index.js";
import type { createMcpService } from "./service.js";
import { createInternalApp } from "../routes/internal.js";
import { EventStreamFixture, type Person } from "../testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  enableConnector,
  leaseRun,
  mcpToken,
  registerConnector,
  MCP_VERIFY_KEYS,
} from "../testing/mcp-fixtures.js";

/**
 * The MCP proxy's policy re-check on the server (KOBE-58) against a real Postgres: sandbox
 * authentication, exposure, run binding, the policy engine at `enforcement_point: mcp_proxy`,
 * signed approvals (Gate 2: a tampered kobe-policy cannot execute an MCP write without a valid
 * signed approval) and the `mcp.tool_call` audit.
 */
export const fx = new EventStreamFixture();
export const KEYRING = approvalKeyring("a".repeat(48));
export const FORGED = { kid: KEYRING.current.kid, secret: new Uint8Array(32).fill(9) };
export const live = new Set<string>();
export let app: ReturnType<typeof createInternalApp>;

export function internalApp(mcp: ReturnType<typeof createMcpService>) {
  return createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp,
    auth: {
      db: fx.db,
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
}

export interface World {
  readonly team: string;
  readonly owner: Person;
  readonly sandboxId: string;
  readonly token: string;
  readonly runId: string;
  readonly threadId: string;
  readonly connector: { id: string; name: string; tools: PinnedTool[] };
}

export async function world(
  options: { exposure?: "read_only" | "all" | "custom"; enabledTools?: string[] } = {},
): Promise<World> {
  const owner = await fx.person(`m${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`mcp-${randomUUID().slice(0, 6)}`, owner);
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, owner);
  const threadId = await leaseRun(fx.admin, team, runId, owner.id, sandboxId);
  const connector = await registerConnector(fx.admin);
  await enableConnector(
    fx.admin,
    team,
    connector.id,
    owner.id,
    options.exposure ?? "all",
    options.enabledTools ?? [],
  );
  const token = mcpToken({ sandboxId, teamId: team, userId: owner.id });
  return { team, owner, sandboxId, token, runId, threadId, connector };
}

export type Body = Record<string, unknown>;

export async function post(
  path: string,
  body: Body | undefined,
  headers: Record<string, string>,
  target = app,
): Promise<{ status: number; json: Body }> {
  const res = await target.request(`/internal/v1/mcp${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Body };
}

export const auth = (token: string) => ({
  authorization: `Bearer ${INTERNAL_KEY}`,
  "kaiju-sandbox-token": token,
});
export const listTools = (w: World, token = w.token, target = app) =>
  post(`/connectors/${w.connector.id}/tools`, undefined, auth(token), target);
export const callTool = (w: World, body: Body, token = w.token, target = app) =>
  post(
    `/connectors/${w.connector.id}/calls`,
    { thread_id: w.threadId, arguments: { q: "x" }, ...body },
    auth(token),
    target,
  );

export async function auditRows(team: string) {
  const { rows } = await fx.admin.query<{ target: Body; actor_id: string }>(
    `SELECT target, actor_id FROM audit_log WHERE team_id = $1 AND action = 'mcp.tool_call' ORDER BY seq`,
    [team],
  );
  return rows;
}

export const digest = (input: JsonObject) =>
  createHash("sha256").update(canonicalJson(input)).digest("hex");

/** Registers the shared hooks; call once at the top level of each mcp.*.db.test.ts file. */
export function useMcpWorld(): void {
  beforeAll(async () => {
    await fx.setup([{}], () => ({
      sandboxWire: { sweep: false },
      approvalKeys: KEYRING,
    }));
    app = internalApp(fx.replica(0).deps.mcp);
  });

  afterAll(() => fx.teardown());
}
