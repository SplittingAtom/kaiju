// Shared setup for the git-tools.*.db.test.ts files (split from git-tools.db.test.ts, KOBE-725).
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { withTestLoopback } from "@kaiju/address-policy/testing";
import {
  GIT_SITE_ALLOWED_HOSTS_KEY,
  GIT_SITE_ENABLED_KEY,
  loadEnvelope,
  type Envelope,
} from "@kaiju/db";
import { rawRequest } from "../connectors/oauth/http.js";
import { GIT_TOOLS } from "./catalog.js";
import { KaijuMcpHarness, type KaijuSandbox } from "../testing/kaiju-mcp-harness.js";
import type { Person } from "../testing/event-stream-fixture.js";
import { FAKE_GITEA_TOKEN, FakeGitea } from "../testing/fake-gitea.js";
import { FAKE_PAT, FakeGithub } from "../testing/fake-github.js";

/**
 * KOBE-762 (GIT-6, spec workspace-git G9-G13, §9) end to end on a real Postgres: a sandbox calls
 * the real MCP proxy, the server decides (policy, the git access check, signed approvals, audit)
 * and calls the fake git hosts with the Workspace's sealed credential. The sandbox is "tampered":
 * it never sends `policy.check`, so only the proxy-side re-check stands.
 *
 * ac-1: every call through policy and, where needed, a signed approval of exactly that input;
 * ac-2: writes refused at Read, for readers, and outside the Workspace's connections;
 * ac-3: GitHub (fake), Gitea and Forgejo, posts naming the member and the conversation.
 */
export const must = <T>(v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error("expected a value");
  return v;
};
export const h = new KaijuMcpHarness();
export const forgejo = new FakeGitea("forgejo");
export const gitea = new FakeGitea("gitea");
export const github = new FakeGithub();
export let envelope: Envelope;
export const seen: string[] = [];

export const https = (fake: { baseUrl: string }) => fake.baseUrl.replace(/^http:/, "https:");
export type Fake = "forgejo" | "gitea" | "github";
export const BODIES: Record<Fake, () => Record<string, unknown>> = {
  forgejo: () => ({
    provider: "forgejo",
    base_url: https(forgejo),
    organization: "acme",
    credential: { kind: "access_token", token: FAKE_GITEA_TOKEN },
  }),
  gitea: () => ({
    provider: "gitea",
    base_url: https(gitea),
    organization: "acme",
    credential: { kind: "access_token", token: FAKE_GITEA_TOKEN },
  }),
  github: () => ({
    provider: "github",
    base_url: https(github),
    organization: github.organization,
    credential: { kind: "access_token", token: FAKE_PAT },
  }),
};

export interface World {
  readonly team: string;
  readonly admin: Person;
  readonly reader: Person;
  readonly contributor: Person;
}

export async function world(): Promise<World> {
  const w = await h.world(null);
  await h.fx.admin.query(
    `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
    [w.team, w.target.id],
  );
  await h.fx.admin.query(`UPDATE users SET name = 'Ana Lee' WHERE id = $1`, [w.target.id]);
  return { team: w.team, admin: w.admin, reader: w.member, contributor: w.target };
}

export async function connect(
  w: World,
  fake: Fake,
  level: "read" | "read_write" = "read_write",
): Promise<string> {
  const res = await w.admin.browser.request("POST", "/v1/team/git/connections", {
    ...BODIES[fake](),
    access_level: level,
  });
  expect(res.status, res.text).toBe(201);
  return (res.json as { connection: { id: string } }).connection.id;
}

export const GIT = GIT_TOOLS.map((t) => t.name);
export const READS = GIT_TOOLS.filter((t) => t.readOnly).map((t) => t.name);
export const gitNames = async (s: KaijuSandbox) =>
  (await h.listNames(s)).filter((n) => n.startsWith("git_"));

export async function auditRows(team: string, prefix = "git.") {
  const { rows } = await h.fx.admin.query<{
    action: string;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT action, actor_id, target FROM audit_log
      WHERE team_id = $1 AND action LIKE $2 ORDER BY seq`,
    [team, `${prefix}%`],
  );
  seen.push(JSON.stringify(rows));
  return rows;
}

export const call = async (
  s: KaijuSandbox,
  tool: string,
  input: Record<string, unknown>,
  id?: string,
) => {
  const out = await h.call(s, tool, input, id);
  seen.push(out.text);
  return out;
};
export const approved = async (s: KaijuSandbox, tool: string, input: Record<string, unknown>) => {
  const { approval, out } = await h.approvedCall(s, tool, input);
  seen.push(out.text);
  return { approval, out };
};

/** Registers the shared hooks; call once at the top level of each git-tools.*.db.test.ts file. */
export function useGitToolsWorld(): void {
  beforeAll(async () => {
    await Promise.all([forgejo.start(), gitea.start(), github.start()]);
    envelope = must(loadEnvelope({ KOBE_ENVELOPE_KEY: "t".repeat(48) }));
    await h.setup({
      envelope,
      // https in the table; the hook sends the checked https URL to the fake's plain-HTTP port.
      gitHostRequest: (url, io, init) =>
        rawRequest(new URL(url.href.replace(/^https:/, "http:")), io, init),
      connectors: {
        allowHttp: false,
        allowedPorts: [forgejo.port, gitea.port, github.port],
        allowedInternalCidrs: [],
        addresses: withTestLoopback(),
        resolve: () => Promise.resolve(["127.0.0.1"]),
      },
    });
    // KOBE-762: the git tools are the built-in git connector's.
    h.builtin = "git";
  }, 120_000);

  afterAll(async () => {
    await h.teardown();
    await Promise.all([forgejo.close(), gitea.close(), github.close()]);
  });

  beforeEach(async () => {
    forgejo.reset();
    gitea.reset();
    github.reset();
    for (const f of [forgejo, gitea]) f.seedRepositories(["docs"]);
    github.seedRepositories(["docs"]);
    await h.fx.admin.query(`DELETE FROM site_settings WHERE key IN ($1, $2)`, [
      GIT_SITE_ENABLED_KEY,
      GIT_SITE_ALLOWED_HOSTS_KEY,
    ]);
    await h.fx.admin.query(`DELETE FROM kobe_rate_limits WHERE key LIKE 'kobe:git-tools:%'`);
  });
}
