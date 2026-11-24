import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvelope, sealGitCredential, type Envelope } from "@kaiju/db";
import { generateSessionKeyPair, signSessionToken } from "@kaiju/session-token";
import type { GitAccess, GitHostAdapter } from "./adapter.js";
import { GitHostError } from "./adapter.js";
import type { GitAdapterInput } from "./factory.js";
import { logger } from "../logger.js";
import { createInternalApp } from "../routes/internal.js";
import { INTERNAL_KEY, MCP_SESSION_KEY, MCP_VERIFY_KEYS } from "../testing/mcp-fixtures.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-763: the egress proxy's git decisions on the internal listener. The server matches the
 * connection (host, base path, organization), decides read or write (G12), checks the Site, opens
 * the sealed credential and asks the adapter for a per-repository credential. The credential goes
 * back to the proxy only: never into a log.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const EGRESS_PAIR = generateSessionKeyPair();
const GIT_KEY = "g".repeat(40);
const TOKEN_SECRET = "ghp_FAKEfakeFAKEfakeFAKEfake0123";
const team = randomUUID();
const otherTeam = randomUUID();
let h: Harness;
let envelope: Envelope;
let internal: ReturnType<typeof createInternalApp>;
const ids: Record<string, string> = {};
const logged: string[] = [];
const minted: { repository: string; access: GitAccess; input: GitAdapterInput }[] = [];
let adapterError: GitHostError | undefined;
const HOST_IDS: Record<string, string> = {
  app: "1",
  readonly: "2",
  docs: "42",
  "docs-renamed": "42",
  legacy: "77",
  "legacy-new-name": "77",
};

function egressToken(userId: string, teamId = team, aud = "kobe.egress-proxy"): string {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: aud as "kobe.egress-proxy",
      sub: randomUUID(),
      team_id: teamId,
      user_id: userId,
      iat: now,
      exp: now + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    aud === "kobe.egress-proxy" ? EGRESS_PAIR.signing : MCP_SESSION_KEY,
  );
}

const fakeAdapter = (input: GitAdapterInput): GitHostAdapter =>
  ({
    provider: input.connection.provider,
    // The host's stable ids: `docs-renamed` is `docs` after a rename on the host; `legacy` is
    // the Repo whose connection was removed and re-added.
    getRepository: async (ref: { name: string }) => {
      if (adapterError) throw adapterError;
      const id = HOST_IDS[ref.name.toLowerCase()];
      if (id === undefined) throw new GitHostError("not_found", "not found");
      return { id, name: ref.name, fullName: `acme/${ref.name}` };
    },
    repositoryCredential: async (repository: string, access: GitAccess) => {
      if (adapterError) throw adapterError;
      minted.push({ repository, access, input });
      return {
        username: "x-access-token",
        password: input.secret.kind === "access_token" ? input.secret.token : "ghs_minted",
        expiresAt: null,
        access,
        narrowed: false,
      };
    },
  }) as unknown as GitHostAdapter;

async function addConnection(
  over: { baseUrl?: string; organization?: string; access?: string; agents?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const sealed = sealGitCredential(
    envelope,
    { teamId: team, connectionId: id },
    { kind: "access_token", token: TOKEN_SECRET },
  );
  await h.admin.query(
    `INSERT INTO git_connections (team_id, id, provider, base_url, organization, display_name,
       credential_kind, credential_sealed, credential_key_id, credential_hint, access_level,
       agent_ids, created_by)
     VALUES ($1, $2, 'github', $3, $4, 'Acme', 'access_token', $5, $6, '••••0123', $7, $8, $9)`,
    [
      team,
      id,
      over.baseUrl ?? "https://github.com",
      over.organization ?? "acme",
      sealed.credentialSealed,
      sealed.credentialKeyId,
      over.access ?? "read_write",
      over.agents === undefined ? null : over.agents,
      ids.admin,
    ],
  );
  return id;
}

beforeAll(async () => {
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  envelope = must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) }));
  h = await openHarness({ envelope });
  for (const [id, slug] of [
    [team, "gt"],
    [otherTeam, "go"],
  ] as const) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      id,
      `${slug}-${id.slice(0, 6)}`,
    ]);
  }
  for (const [name, role] of [
    ["admin", "team_admin"],
    ["contrib", "contributor"],
    ["editor", "contributor"],
    ["reader", "member"],
  ] as const) {
    ids[name] = await h.createUser(`${name}-${team.slice(0, 6)}@git.test`);
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[name],
      role,
    ]);
  }
  ids.outsider = await h.createUser(`outsider-${team.slice(0, 6)}@git.test`);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'contributor')`,
    [otherTeam, ids.outsider],
  );
  ids.github = await addConnection();
  ids.readonly = await addConnection({
    baseUrl: "https://git.example.test/forgejo",
    access: "read",
  });
  ids.off = await addConnection({ baseUrl: "https://off.example.test", access: "off" });
  ids.agents = await addConnection({
    baseUrl: "https://agents.example.test",
    agents: `{${randomUUID()}}`,
  });
  // A Repo (G15): project `docs` is the record of acme/docs; `editor` edits it.
  const project = randomUUID();
  await h.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, kind, created_by) VALUES ($1, $2, 'docs', 'Docs', 'repo', $3)`,
    [team, project, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO project_members (team_id, project_id, user_id, role, added_by) VALUES ($1, $2, $3, 'editor', $4)`,
    [team, project, ids.editor, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name, project_id, origin, created_by)
     VALUES ($1, $2, 'https://github.com', '42', 'acme/docs', $3, 'conversion', $4)`,
    [team, ids.github, project, ids.admin],
  );
  // A Repo whose connection was removed (connection_id cleared, G20) before this one was added.
  const legacy = randomUUID();
  await h.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, kind, created_by) VALUES ($1, $2, 'legacy', 'Legacy', 'repo', $3)`,
    [team, legacy, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name, project_id, origin, created_by)
     VALUES ($1, NULL, 'https://github.com', '77', 'acme/legacy', $2, 'conversion', $3)`,
    [team, legacy, ids.admin],
  );
  internal = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: h.deps.mcp,
    auth: {
      db: h.deps.database.db,
      sessionVerifyKeys: MCP_VERIFY_KEYS,
      liveness: { isLive: () => Promise.resolve(true) },
    },
    git: {
      internalKey: GIT_KEY,
      auth: {
        db: h.deps.database.db,
        sessionVerifyKeys: EGRESS_PAIR.verify,
        liveness: { isLive: () => Promise.resolve(true) },
        audience: "kobe.egress-proxy",
      },
      transport: {
        db: h.deps.database.db,
        envelope,
        net: { policy: h.deps.connectorUrlPolicy },
        adapterFor: fakeAdapter,
      },
    },
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

interface Ask {
  readonly user?: string;
  readonly token?: string;
  readonly key?: string;
  readonly host?: string;
  readonly prefix?: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly service?: string;
}

async function ask(a: Ask = {}) {
  const res = await internal.request("/internal/v1/git/transport", {
    method: "POST",
    headers: {
      authorization: `Bearer ${a.key ?? GIT_KEY}`,
      "kobe-sandbox-token": a.token ?? egressToken(ids[a.user ?? "contrib"] ?? ""),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      host: a.host ?? "github.com",
      prefix: a.prefix ?? "",
      owner: a.owner ?? "acme",
      repository: a.repository ?? "app",
      service: a.service ?? "git-upload-pack",
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const PUSH = "git-receive-pack";

describe("git transport decisions (KOBE-763)", () => {
  it("lets any member fetch and returns a per-repository credential", async () => {
    const res = await ask({ user: "reader", owner: "ACME" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      decision: "allow",
      connection_id: ids.github,
      base_path: "",
      organization: "acme",
      repository: "app",
      access: "read",
      username: "x-access-token",
      password: TOKEN_SECRET,
      push_limit_bytes: 1024 * 1024 * 1024,
    });
    expect(minted.at(-1)).toMatchObject({ repository: "app", access: "read" });
  });

  it("lets a contributor push at Read and write; refuses readers", async () => {
    expect((await ask({ user: "contrib", service: PUSH })).json).toMatchObject({
      decision: "allow",
      access: "write",
    });
    expect((await ask({ user: "reader", service: PUSH })).json).toMatchObject({
      decision: "deny",
      code: "role_reader",
    });
  });

  it("refuses a push at Read, and everything on a connection that is off or limited to agents", async () => {
    const readOnly = await ask({
      host: "git.example.test",
      prefix: "/forgejo",
      service: PUSH,
    });
    expect(readOnly.json).toMatchObject({ decision: "deny", code: "read_only" });
    expect((await ask({ host: "git.example.test", prefix: "/forgejo" })).json).toMatchObject({
      decision: "allow",
      base_path: "/forgejo",
    });
    expect((await ask({ host: "off.example.test" })).json).toMatchObject({
      code: "connection_off",
    });
    expect((await ask({ host: "agents.example.test" })).json).toMatchObject({
      code: "agents_restricted",
    });
  });

  it("refuses another organization on a connected host; a host or path without one is no_connection", async () => {
    const outside = await ask({ owner: "evil", service: PUSH });
    expect(outside.json).toMatchObject({ decision: "deny", code: "outside_organization" });
    expect(String(outside.json.message)).toContain("outside the organization");
    expect((await ask({ host: "gitlab.example.test" })).json).toMatchObject({
      code: "no_connection",
    });
    // The base path is part of the match: the Forgejo connection lives under /forgejo only.
    expect((await ask({ host: "git.example.test", prefix: "" })).json).toMatchObject({
      code: "no_connection",
    });
  });

  it("needs editor or owner on a Repo's project to push (G12)", async () => {
    expect((await ask({ user: "contrib", repository: "docs", service: PUSH })).json).toMatchObject({
      code: "project_reader",
    });
    expect((await ask({ user: "editor", repository: "DOCS", service: PUSH })).json).toMatchObject({
      decision: "allow",
      access: "write",
    });
    expect((await ask({ user: "admin", repository: "docs", service: PUSH })).json).toMatchObject({
      decision: "allow",
    });
    expect((await ask({ user: "contrib", repository: "docs" })).json).toMatchObject({
      decision: "allow",
      access: "read",
    });
  });

  it("keeps the Repo rule after a rename on the host (matched by the host's id)", async () => {
    expect(
      (await ask({ user: "contrib", repository: "docs-renamed", service: PUSH })).json,
    ).toMatchObject({ code: "project_reader" });
    expect(
      (await ask({ user: "editor", repository: "docs-renamed", service: PUSH })).json,
    ).toMatchObject({ decision: "allow", access: "write" });
  });

  it("keeps the Repo rule after a reconnect (row without a connection), by id and by name", async () => {
    for (const repository of ["legacy", "legacy-new-name"]) {
      expect((await ask({ user: "contrib", repository, service: PUSH })).json).toMatchObject({
        code: "project_reader",
      });
    }
    expect(
      (await ask({ user: "admin", repository: "legacy-new-name", service: PUSH })).json,
    ).toMatchObject({
      decision: "allow",
    });
  });

  it("reads a Repo with a role on its project, also after a rename or a reconnect (M4)", async () => {
    // Every Workspace member is at least an implicit reader of every project (KOBE-587).
    for (const repository of ["docs", "docs-renamed", "legacy", "legacy-new-name"]) {
      expect((await ask({ user: "reader", repository })).json).toMatchObject({
        decision: "allow",
        access: "read",
      });
    }
  });

  it("refuses a fetch it cannot resolve while the host has Repos, exactly as a missing one (M4)", async () => {
    const before = minted.length;
    const ghost = (await ask({ user: "reader", repository: "ghost" })).json;
    expect(ghost).toMatchObject({ decision: "deny", code: "repository_unavailable" });
    expect(minted.length).toBe(before);
  });

  it("refuses a push to a repository it cannot resolve, without minting (fail closed)", async () => {
    const before = minted.length;
    expect((await ask({ user: "contrib", repository: "ghost", service: PUSH })).json).toMatchObject(
      {
        code: "repository_unavailable",
      },
    );
    expect(minted.length).toBe(before);
  });

  it("maps adapter refusals to fixed messages", async () => {
    adapterError = new GitHostError("not_found", "nope");
    expect((await ask()).json).toMatchObject({ code: "repository_unavailable" });
    adapterError = new GitHostError("auth_failed", "nope");
    expect((await ask()).json).toMatchObject({ code: "credential_rejected" });
    adapterError = undefined;
  });

  it("refuses when the Site turns Git off", async () => {
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('git.connections_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
    try {
      expect((await ask()).json).toMatchObject({ code: "site_refused" });
    } finally {
      await h.admin.query(`DELETE FROM site_settings WHERE key = 'git.connections_enabled'`);
    }
  });

  it("authenticates the proxy (its own key) and the sandbox (egress audience, team member)", async () => {
    expect((await ask({ key: INTERNAL_KEY })).status).toBe(401);
    expect((await ask({ key: "x".repeat(40) })).status).toBe(401);
    expect(
      (await ask({ token: egressToken(ids.contrib ?? "", team, "kobe.mcp-proxy") })).status,
    ).toBe(401);
    expect((await ask({ token: egressToken(ids.outsider ?? "", team) })).status).toBe(401);
    expect((await ask({ token: "" })).status).toBe(401);
    // The MCP routes do not accept the egress proxy's key either.
    const mcp = await internal.request(`/internal/v1/mcp/kobe/list`, {
      method: "POST",
      headers: { authorization: `Bearer ${GIT_KEY}` },
    });
    expect(mcp.status).toBe(401);
  });

  it("validates the request strictly", async () => {
    for (const bad of [
      { prefix: "/../x" },
      { owner: "../acme" },
      { repository: "app.git" },
      { repository: ".." },
      { service: "git-upload-archive" },
      { host: "GitHub.com" },
    ]) {
      expect((await ask(bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("never logs the credential", () => {
    expect(logged.join("\n")).not.toContain(TOKEN_SECRET);
    expect(logged.some((l) => l.includes("git transport decision"))).toBe(true);
  });
});
