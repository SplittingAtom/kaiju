import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import {
  GIT_SITE_ALLOWED_HOSTS_KEY,
  GIT_SITE_ENABLED_KEY,
  loadEnvelope,
  openGitCredential,
  verifyAuditChain,
  type Envelope,
} from "@kobe/db";
import { gitConnectionAdminViewSchema, gitConnectionMemberViewSchema } from "@kobe/protocol";
import { rawRequest } from "../connectors/oauth/http.js";
import { notifyGitTokenExpiry } from "./expiry-notify.js";
import { runGitHealthPass, GitHostBackoff } from "./health-job.js";
import { logger } from "../logger.js";
import { EventStreamFixture, type Person } from "../testing/event-stream-fixture.js";
import { FAKE_GITEA_TOKEN, FakeGitea } from "../testing/fake-gitea.js";
import { FAKE_APP_ID, FAKE_INST_ID, FAKE_PAT, FakeGithub } from "../testing/fake-github.js";
import type { MemoryMailer } from "../testing/mailer.js";

/**
 * KOBE-760 (GIT-4, spec workspace-git §3, §4, §7, §8): the connection routes end to end on a real
 * Postgres against the adapters' fake hosts. ac-1: a credential that fails its test is refused and
 * a passing one answers what it may do; ac-2: no answer, audit row or log line carries credential
 * material; ac-3: the cap of 5 (race-safe), one connection per host and organization, the Site
 * switch and host list, and the expiry notice job.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/team/git/connections";
const short = () => randomUUID().slice(0, 8);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
/** A line from the middle of the key: any copy of the key in text contains it. */
const PEM_LINE = PRIVATE_PEM.split("\n")[5] ?? "";

const fx = new EventStreamFixture();
const forgejo = new FakeGitea("forgejo");
const gitea = new FakeGitea("gitea");
const github = new FakeGithub(PUBLIC_PEM);
let envelope: Envelope;

/** Every response body, audit row and log line the tests saw, for the leak checks (ac-2). */
const seen: string[] = [];
const logged: string[] = [];

beforeAll(async () => {
  await Promise.all([forgejo.start(), gitea.start(), github.start()]);
  envelope = must(loadEnvelope({ KOBE_ENVELOPE_KEY: "g".repeat(48) }));
  await fx.setup([{}], () => ({
    envelope,
    // The table stores https base URLs only: the test asks for https and the hook below sends it
    // to the fake's plain-HTTP port, after the address policy checked the https URL.
    gitHostRequest: (url, io, init) =>
      rawRequest(new URL(url.href.replace(/^https:/, "http:")), io, init),
    connectors: {
      allowHttp: false,
      allowedPorts: [forgejo.port, gitea.port, github.port],
      allowedInternalCidrs: [],
      addresses: withTestLoopback(),
      // Two made-up names for the L2 test: one does not resolve, one is a private address.
      resolve: (host: string) =>
        host === "nowhere.fake.test"
          ? Promise.reject(new Error("ENOTFOUND"))
          : Promise.resolve(host === "private.fake.test" ? ["10.0.0.5"] : ["127.0.0.1"]),
    },
  }));
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const original = logger[level].bind(logger) as (...args: unknown[]) => void;
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args, (_k, v: unknown) => (v instanceof Error ? String(v) : v)));
      original(...args);
    }) as never);
  }
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await fx.teardown();
  await Promise.all([forgejo.close(), gitea.close(), github.close()]);
});

beforeEach(async () => {
  forgejo.reset();
  gitea.reset();
  github.reset();
  await fx.admin.query(`DELETE FROM site_settings WHERE key IN ($1, $2)`, [
    GIT_SITE_ENABLED_KEY,
    GIT_SITE_ALLOWED_HOSTS_KEY,
  ]);
});

const healthDeps = () => ({
  db: fx.db,
  envelope,
  net: fx.replica(0).deps.gitHostNet,
  mailer: fx.replica(0).deps.mailer,
  publicUrl: "http://kobe.test",
  logger,
  recheckMs: 0,
});

interface World {
  readonly team: string;
  readonly admin: Person;
  readonly member: Person;
  readonly contributor: Person;
}

async function world(): Promise<World> {
  const admin = await fx.person(`ga${short()}`);
  const member = await fx.person(`gm${short()}`);
  const contributor = await fx.person(`gc${short()}`);
  const team = await fx.team(`git-${short()}`, admin, [member, contributor]);
  await fx.admin.query(
    `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
    [team, contributor.id],
  );
  return { team, admin, member, contributor };
}

/** The fake's address as a connection names it (https; see the request hook). */
const https = (fake: { baseUrl: string }) => fake.baseUrl.replace(/^http:/, "https:");
const token = (value = FAKE_GITEA_TOKEN) => ({ kind: "access_token", token: value });
const forgejoBody = (over: Record<string, unknown> = {}) => ({
  provider: "forgejo",
  base_url: https(forgejo),
  organization: "acme",
  credential: token(),
  ...over,
});
const giteaBody = (over: Record<string, unknown> = {}) => ({
  ...forgejoBody({ provider: "gitea", base_url: https(gitea) }),
  ...over,
});
const githubTokenBody = (over: Record<string, unknown> = {}) => ({
  provider: "github",
  base_url: https(github),
  organization: github.organization,
  credential: token(FAKE_PAT),
  ...over,
});
const githubAppBody = () =>
  githubTokenBody({
    credential: {
      kind: "github_app",
      app_id: Number(FAKE_APP_ID),
      installation_id: Number(FAKE_INST_ID),
      private_key: PRIVATE_PEM,
    },
  });

async function call(p: Person, method: string, path: string, body?: unknown) {
  const res = await p.browser.request(method, path, body);
  seen.push(res.text);
  return res;
}

async function create(w: World, body: unknown) {
  const res = await call(w.admin, "POST", BASE, body);
  return res;
}

async function auditRows(team: string, prefix = "git.") {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE $2 ORDER BY seq`,
    [team, `${prefix}%`],
  );
  seen.push(JSON.stringify(rows));
  return rows;
}

async function stored(team: string) {
  const { rows } = await fx.admin.query<{
    id: string;
    credential_sealed: string;
    credential_key_id: string;
    credential_kind: "access_token" | "github_app";
  }>(
    `SELECT id, credential_sealed, credential_key_id, credential_kind FROM git_connections
      WHERE team_id = $1 ORDER BY created_at`,
    [team],
  );
  return rows;
}

describe("connect (G2, G4, G8; ac-1)", () => {
  it("tests, then stores a sealed credential and answers what it may do", async () => {
    const w = await world();
    const res = await create(w, forgejoBody({ access_level: "read_write" }));
    expect(res.status, res.text).toBe(201);
    const view = gitConnectionAdminViewSchema.parse(res.json.connection);
    expect(view).toMatchObject({
      provider: "forgejo",
      organization: "acme",
      display_name: "acme on Forgejo",
      access_level: "read_write",
      credential: { kind: "access_token", hint: "••••cdef", github_app_id: null },
      capabilities: { read: "yes", write: "yes" },
      health: { status: "ok", last_error: null },
    });
    expect(res.json.test).toMatchObject({
      ok: true,
      provider: "forgejo",
      actor: { login: "kobe-bot" },
    });

    const [row] = await stored(w.team);
    expect(row?.credential_sealed.startsWith("e1.")).toBe(true);
    const secret = openGitCredential(
      envelope,
      { teamId: w.team, connectionId: view.id },
      must(row).credential_sealed,
      "access_token",
    );
    expect(secret).toEqual({ kind: "access_token", token: FAKE_GITEA_TOKEN });
    expect(await auditRows(w.team)).toEqual([
      {
        action: "git.connection.created",
        target: {
          connectionId: view.id,
          provider: "forgejo",
          host: "git.fake.test",
          organization: "acme",
          credentialKind: "access_token",
          accessLevel: "read_write",
          excessPermissions: [],
        },
      },
    ]);
  });

  it("connects a GitHub App (G5); the private key is never answered", async () => {
    const w = await world();
    github.options = { installationAccount: github.organization };
    const res = await create(w, githubAppBody());
    expect(res.status, res.text).toBe(201);
    expect(res.json.connection.credential).toMatchObject({
      kind: "github_app",
      hint: null,
      github_app_id: Number(FAKE_APP_ID),
      github_installation_id: Number(FAKE_INST_ID),
    });
    expect(res.text).not.toContain(PEM_LINE);
  });

  it("tests without saving; refuses a failing credential and says what it may do", async () => {
    const w = await world();
    const tested = await call(w.admin, "POST", `${BASE}/test`, forgejoBody());
    expect(tested.status, tested.text).toBe(200);
    expect(tested.json.test).toMatchObject({ ok: true, capabilities: { read: "yes" } });
    expect(await stored(w.team)).toEqual([]);

    forgejo.fail("auth");
    const rejected = await create(w, forgejoBody());
    expect(rejected.status).toBe(422);
    expect(rejected.json).toMatchObject({
      code: "credential_rejected",
      test: { code: "auth_failed" },
    });
    forgejo.fail(null);

    forgejo.canWrite = false;
    const short = await create(w, forgejoBody({ access_level: "read_write" }));
    expect(short.status).toBe(422);
    expect(short.json).toMatchObject({
      code: "credential_insufficient",
      test: { ok: false, missing: ["write"], capabilities: { read: "yes", write: "no" } },
    });
    forgejo.makeTooOld();
    const old = await create(w, forgejoBody());
    expect(old.status).toBe(422);
    expect(old.json.code).toBe("unsupported_host");
    expect(await stored(w.team)).toEqual([]);
    const failures = (await auditRows(w.team)).map((r) => [
      r.action,
      r.target.stage,
      r.target.failure,
    ]);
    expect(failures).toEqual([
      ["git.connection.test_failed", "create", "auth_failed"],
      ["git.connection.test_failed", "create", "credential_insufficient"],
      ["git.connection.test_failed", "create", "unsupported_host"],
    ]);
  });

  it("detects Forgejo picked as Gitea, refuses internal on Gitea, validates without echoing", async () => {
    const w = await world();
    const wrong = await create(w, giteaBody({ base_url: https(forgejo) }));
    expect(wrong.status, wrong.text).toBe(201);
    expect(wrong.json.connection.provider).toBe("forgejo");
    const internal = await create(w, giteaBody({ repo_visibility: "internal" }));
    expect(internal.status).toBe(422);
    expect(internal.json.code).toBe("internal_not_offered");
    const plain = await create(w, giteaBody({ base_url: gitea.baseUrl }));
    expect([plain.status, plain.json.code]).toEqual([422, "invalid_base_url"]);
    const bad = await create(w, {
      ...giteaBody(),
      credential: { kind: "access_token", token: "has space secret-xyz" },
    });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("secret-xyz");
    const appOnGitea = await create(w, { ...giteaBody(), credential: githubAppBody().credential });
    expect(appOnGitea.status).toBe(400);
    expect(appOnGitea.text).not.toContain(PEM_LINE);
  });

  it("refuses the same organization twice (G2), ignoring case", async () => {
    const w = await world();
    expect((await create(w, forgejoBody())).status).toBe(201);
    const again = await create(w, forgejoBody({ organization: "ACME" }));
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("already_connected");
  });
});

describe("the cap of 5 (G2, ac-3)", () => {
  it("holds under concurrent connects", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) {
      await fx.admin.query(
        `INSERT INTO git_connections (team_id, provider, base_url, organization, display_name,
           credential_kind, credential_sealed, credential_key_id, created_by)
         VALUES ($1, 'forgejo', 'https://git.seed.test', $2, 'Seed', 'access_token',
           'e1.seed.not-a-real-envelope', 'seed', $3)`,
        [w.team, `seed-${i}`, w.admin.id],
      );
    }
    github.options = { installationAccount: github.organization };
    const results = await Promise.all([
      create(w, forgejoBody()),
      create(w, giteaBody()),
      create(w, githubTokenBody()),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 409]);
    expect(results.find((r) => r.status === 409)?.json.code).toBe("connection_limit");
    expect((await stored(w.team)).length).toBe(5);
  });
});

describe("the Site ceiling (G3, ac-3)", () => {
  it("refuses when Git is off or the host is not allowed, before calling the host", async () => {
    const w = await world();
    await fx.admin.query(`INSERT INTO site_settings (key, value) VALUES ($1, 'false')`, [
      GIT_SITE_ENABLED_KEY,
    ]);
    const off = await create(w, forgejoBody());
    expect([off.status, off.json.code]).toEqual([403, "git_disabled"]);
    const offTest = await call(w.admin, "POST", `${BASE}/test`, forgejoBody());
    expect([offTest.status, offTest.json.code]).toEqual([403, "git_disabled"]);
    await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [GIT_SITE_ENABLED_KEY]);
    await fx.admin.query(`INSERT INTO site_settings (key, value) VALUES ($1, $2)`, [
      GIT_SITE_ALLOWED_HOSTS_KEY,
      JSON.stringify(["github.com"]),
    ]);
    const limited = await create(w, forgejoBody());
    expect([limited.status, limited.json.code]).toEqual([403, "host_not_allowed"]);
    expect(forgejo.apiHits()).toEqual([]);
    const list = await call(w.admin, "GET", BASE);
    expect(list.json.site).toEqual({ enabled: true, allowed_hosts: ["github.com"] });
  });

  it("an existing connection's check is refused once the Site turns Git off", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    await fx.admin.query(`INSERT INTO site_settings (key, value) VALUES ($1, 'false')`, [
      GIT_SITE_ENABLED_KEY,
    ]);
    const check = await call(w.admin, "POST", `${BASE}/${id}/check`);
    expect([check.status, check.json.code]).toEqual([403, "git_disabled"]);
  });

  it("a host the Site dropped shows as not allowed, without a host call; allowed again, it recovers", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    await fx.admin.query(`INSERT INTO site_settings (key, value) VALUES ($1, $2)`, [
      GIT_SITE_ALLOWED_HOSTS_KEY,
      JSON.stringify(["github.com"]),
    ]);
    const hits = forgejo.apiHits().length;
    const check = await call(w.admin, "POST", `${BASE}/${id}/check`);
    expect([check.status, check.json.code]).toEqual([403, "host_not_allowed"]);
    const asAdmin = await call(w.admin, "GET", `${BASE}/${id}`);
    expect(asAdmin.json.connection.health).toMatchObject({
      status: "not_allowed",
      last_error: "host_refused:site_host_limit",
    });
    expect((await call(w.member, "GET", `${BASE}/${id}`)).json.connection.status).toBe(
      "not_allowed",
    );
    expect(forgejo.apiHits().length).toBe(hits);
    await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [GIT_SITE_ALLOWED_HOSTS_KEY]);
    // Not due by age (6 h), but a Site refusal is re-decided every pass.
    await runGitHealthPass({ ...healthDeps(), recheckMs: 6 * 3600_000 }, new GitHostBackoff());
    const after = await call(w.admin, "GET", `${BASE}/${id}`);
    expect(after.json.connection.health.status).toBe("ok");
  });

  it("with no host list, an unresolvable name and a refused private address read the same (L2)", async () => {
    const w = await world();
    const answers = [];
    for (const host of ["nowhere.fake.test", "private.fake.test"]) {
      const body = forgejoBody({ base_url: `https://${host}:${forgejo.port}` });
      const res = await call(w.admin, "POST", `${BASE}/test`, body);
      answers.push([res.status, res.json]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]?.[0]).toBe(422);
    expect(answers[0]?.[1]).toMatchObject({
      code: "host_refused",
      test: { code: "host_refused", reason: "not_reachable" },
    });
    const failures = (await auditRows(w.team)).map((r) => [r.target.failure, r.target.reason]);
    expect(failures).toEqual([
      ["host_refused", "not_reachable"],
      ["host_refused", "not_reachable"],
    ]);
  });

  it("refuses a body over 64 KiB before reading it (L5)", async () => {
    const w = await world();
    const res = await call(
      w.admin,
      "POST",
      BASE,
      forgejoBody({ display_name: "x".repeat(70_000) }),
    );
    expect([res.status, res.json.code]).toEqual([413, "too_large"]);
  });
});

describe("who may call what", () => {
  it("members and contributors read the member view and change nothing; admins do everything", async () => {
    const w = await world();
    const created = await create(w, forgejoBody());
    const id = created.json.connection.id as string;
    for (const p of [w.member, w.contributor]) {
      const list = await call(p, "GET", BASE);
      expect(list.status).toBe(200);
      expect(list.json.connections).toHaveLength(1);
      gitConnectionMemberViewSchema.parse(list.json.connections[0]);
      // KOBE-768: the Convert to repo dialog shows the name prefix; nothing of the credential.
      expect(Object.keys(list.json.connections[0]).sort()).toEqual(
        [
          "access_level",
          "base_url",
          "display_name",
          "id",
          "organization",
          "provider",
          "repo_name_prefix",
          "repo_visibility",
          "status",
        ].sort(),
      );
      expect(typeof list.json.connections[0].repo_name_prefix).toBe("string");
      expect(list.json.site).toEqual({ enabled: true });
      const one = await call(p, "GET", `${BASE}/${id}`);
      gitConnectionMemberViewSchema.parse(one.json.connection);
      for (const [method, path, body] of [
        ["POST", BASE, forgejoBody()],
        ["POST", `${BASE}/test`, forgejoBody()],
        ["PATCH", `${BASE}/${id}`, { access_level: "off" }],
        ["PUT", `${BASE}/${id}/credential`, { credential: token() }],
        ["POST", `${BASE}/${id}/check`, undefined],
        ["DELETE", `${BASE}/${id}`, undefined],
      ] as const) {
        const res = await call(p, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    const admin = await call(w.admin, "GET", BASE);
    gitConnectionAdminViewSchema.parse(admin.json.connections[0]);
  });

  it("a Site admin without membership and another Workspace's admin get nothing", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    const other = await world();
    const siteAdmin = await fx.person(`gs${short()}`);
    await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
      siteAdmin.id,
    ]);
    siteAdmin.browser.team = w.team;
    for (const [method, path, body] of [
      ["GET", BASE, undefined],
      ["GET", `${BASE}/${id}`, undefined],
      ["PATCH", `${BASE}/${id}`, { access_level: "off" }],
      ["DELETE", `${BASE}/${id}`, undefined],
    ] as const) {
      const res = await call(siteAdmin, method, path, body);
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(res.text).not.toContain(id);
    }
    // Another Workspace's admin, in their own Workspace: the id does not exist there.
    expect((await call(other.admin, "GET", BASE)).json.connections).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `${BASE}/${id}`, undefined],
      ["PATCH", `${BASE}/${id}`, { access_level: "off" }],
      ["PUT", `${BASE}/${id}/credential`, { credential: token() }],
      ["POST", `${BASE}/${id}/check`, undefined],
      ["DELETE", `${BASE}/${id}`, undefined],
    ] as const) {
      const res = await call(other.admin, method, path, body);
      expect([res.status, res.json.code], `${method} ${path}`).toEqual([
        404,
        "connection_not_found",
      ]);
    }
    expect((await stored(w.team)).length).toBe(1);
  });
});

describe("change, replace, check, disconnect (G1, G8, G20)", () => {
  it("changes only the settings and audits which", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    const res = await call(w.admin, "PATCH", `${BASE}/${id}`, {
      access_level: "read_write",
      repo_name_prefix: "kobe-",
      push_limit_bytes: 1024,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json.connection).toMatchObject({
      access_level: "read_write",
      repo_defaults: { name_prefix: "kobe-" },
      push_limit_bytes: 1024,
    });
    const unknownAgent = await call(w.admin, "PATCH", `${BASE}/${id}`, {
      agent_ids: [randomUUID()],
    });
    expect(unknownAgent.json.code).toBe("unknown_agent");
    expect((await call(w.admin, "PATCH", `${BASE}/${id}`, { organization: "x" })).status).toBe(400);
    expect(
      (await call(w.admin, "PATCH", `${BASE}/${id}`, { repo_visibility: "internal" })).json.code,
    ).toBe("internal_not_offered");
    const updated = (await auditRows(w.team)).filter((r) => r.action === "git.connection.updated");
    expect(updated.map((r) => r.target)).toEqual([
      {
        connectionId: id,
        fields: ["access_level", "repo_name_prefix", "push_limit_bytes"],
        accessLevel: "read_write",
        previousAccessLevel: "read",
      },
    ]);
  });

  it("replaces the credential only after it passes; the old ciphertext is gone", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    const [before] = await stored(w.team);
    const bad = await call(w.admin, "PUT", `${BASE}/${id}/credential`, {
      credential: token("wrong-token-abcdef123456"),
    });
    expect([bad.status, bad.json.code]).toEqual([422, "credential_rejected"]);
    expect((await stored(w.team))[0]?.credential_sealed).toBe(before?.credential_sealed);
    const good = await call(w.admin, "PUT", `${BASE}/${id}/credential`, { credential: token() });
    expect(good.status, good.text).toBe(200);
    const [after] = await stored(w.team);
    expect(after?.credential_sealed).not.toBe(before?.credential_sealed);
    const { rows } = await fx.admin.query(
      `SELECT count(*)::int AS n FROM git_connections WHERE credential_sealed = $1`,
      [before?.credential_sealed],
    );
    expect(rows[0]?.n).toBe(0);
    const actions = (await auditRows(w.team)).map((r) => [r.action, r.target.stage ?? null]);
    expect(actions).toContainEqual(["git.connection.test_failed", "replace"]);
    expect(actions).toContainEqual(["git.connection.credential_replaced", null]);
  });

  it("checks now and stores the health; a failure is a code, never the host's text", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    const ok = await call(w.admin, "POST", `${BASE}/${id}/check`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ connection: { health: { status: "ok" } }, error: null });
    forgejo.fail("auth");
    const failing = await call(w.admin, "POST", `${BASE}/${id}/check`);
    expect(failing.status).toBe(200);
    expect(failing.json).toMatchObject({
      connection: { health: { status: "failing", last_error: "auth_failed:credential_rejected" } },
      test: null,
      error: { code: "credential_rejected" },
    });
    expect(failing.text).not.toContain("token is required");
  });

  it("disconnects: the credential goes, repository records stay unreachable", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    await fx.admin.query(
      `INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name, origin, created_by)
       VALUES ($1, $2, $3, '42', 'acme/docs', 'tool', $4)`,
      [w.team, id, https(forgejo), w.admin.id],
    );
    const res = await call(w.admin, "DELETE", `${BASE}/${id}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ id, repositories_kept: 1 });
    expect(await stored(w.team)).toEqual([]);
    const { rows } = await fx.admin.query(
      `SELECT connection_id, host_state FROM git_repositories WHERE team_id = $1`,
      [w.team],
    );
    expect(rows).toEqual([{ connection_id: null, host_state: "unreachable" }]);
    expect((await call(w.admin, "DELETE", `${BASE}/${id}`)).status).toBe(404);
    const removed = (await auditRows(w.team)).find((r) => r.action === "git.connection.removed");
    expect(removed?.target).toMatchObject({ connectionId: id, repositories: 1 });
    expect(forgejo.apiHits().filter((h) => h.method === "DELETE")).toEqual([]);
  });
});

describe("health job and token-expiry notices (§7, G6, ac-3)", () => {
  it("re-probes due connections, stores failures as codes and backs off a host that is down", async () => {
    const w = await world();
    const id = (await create(w, forgejoBody())).json.connection.id as string;
    forgejo.fail("auth");
    const backoff = new GitHostBackoff();
    const pass = await runGitHealthPass(healthDeps(), backoff);
    expect(pass.checked).toBeGreaterThanOrEqual(1);
    const { rows } = await fx.admin.query(`SELECT last_error FROM git_connections WHERE id = $1`, [
      id,
    ]);
    expect(rows[0]?.last_error).toBe("auth_failed:credential_rejected");

    forgejo.fail("server_error");
    await runGitHealthPass(healthDeps(), backoff);
    const host = new URL(forgejo.baseUrl).host;
    expect(backoff.blocked(host, Date.now())).toBe(true);
    const hits = forgejo.apiHits().length;
    const deferred = await runGitHealthPass(healthDeps(), backoff);
    expect(deferred.deferred).toBeGreaterThanOrEqual(1);
    expect(forgejo.apiHits().length).toBe(hits);
  });

  it("backs off a rate-limited connection, not its host (L1)", async () => {
    const a = await world();
    const b = await world();
    await create(a, forgejoBody());
    await create(b, forgejoBody());
    forgejo.fail("rate_limited");
    const backoff = new GitHostBackoff();
    await runGitHealthPass(healthDeps(), backoff);
    const host = new URL(forgejo.baseUrl).host;
    expect(backoff.blocked(host, Date.now())).toBe(false);
    forgejo.fail(null);
    // A Workspace connecting now is checked on the next pass; the rate-limited ones wait.
    const c = await world();
    const fresh = (await create(c, forgejoBody())).json.connection.id as string;
    await fx.admin.query(`UPDATE git_connections SET last_checked_at = NULL WHERE id = $1`, [
      fresh,
    ]);
    const next = await runGitHealthPass(healthDeps(), backoff);
    expect(next.deferred).toBeGreaterThanOrEqual(2);
    const { rows } = await fx.admin.query(
      `SELECT last_checked_at IS NOT NULL AS checked, last_error FROM git_connections WHERE id = $1`,
      [fresh],
    );
    expect(rows[0]).toEqual({ checked: true, last_error: null });
  });

  it("emails the Workspace admins once when a token lapses within 14 days", async () => {
    const w = await world();
    const expires = new Date(Date.now() + 5 * 86_400_000);
    const stamp = `${expires.toISOString().slice(0, 10)} ${expires.toISOString().slice(11, 19)} UTC`;
    github.options = { patExpiration: stamp };
    const created = await create(w, githubTokenBody());
    expect(created.status, created.text).toBe(201);
    expect(created.json.connection.credential.expires_soon).toBe(true);
    const mailer = fx.replica(0).deps.mailer as MemoryMailer;
    const before = mailer.sent.length;
    const first = await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(first.noticed).toBeGreaterThanOrEqual(1);
    const mine = mailer.sent.slice(before).filter((m) => m.to === w.admin.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.subject).toContain("expires on");
    expect(mailer.sent.slice(before).some((m) => m.to === w.member.email)).toBe(false);
    seen.push(JSON.stringify(mailer.sent));
    const again = await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(mailer.sent.slice(before).filter((m) => m.to === w.admin.email)).toHaveLength(1);
    expect(again.noticed).toBe(0);
    const notified = (await auditRows(w.team)).filter(
      (r) => r.action === "git.connection.expiry_notified",
    );
    expect(notified).toHaveLength(1);
    expect(notified[0]?.target).toMatchObject({ notified: 1 });
  });
});

describe("token-expiry bell notifications (KOBE-819)", () => {
  async function expiringConnection(w: World, days = 5): Promise<{ id: string; expires: Date }> {
    const expires = new Date(Date.now() + days * 86_400_000);
    const stamp = `${expires.toISOString().slice(0, 10)} ${expires.toISOString().slice(11, 19)} UTC`;
    github.options = { patExpiration: stamp };
    const created = await create(w, githubTokenBody());
    expect(created.status, created.text).toBe(201);
    return { id: created.json.connection.id as string, expires };
  }
  async function bellRows(team: string) {
    const { rows } = await fx.admin.query<{
      user_id: string;
      kind: string;
      git_connection_id: string;
      git_expires_at: Date;
    }>(
      `SELECT user_id, kind, git_connection_id, git_expires_at FROM notifications
        WHERE team_id = $1 AND kind LIKE 'git.%' ORDER BY user_id`,
      [team],
    );
    return rows;
  }
  /** A second Workspace admin, and a former admin who is a member now. */
  async function admins(w: World): Promise<{ second: Person; former: Person }> {
    const second = await fx.person(`gs${short()}`);
    const former = await fx.person(`gf${short()}`);
    for (const p of [second, former]) {
      await fx.addMember(w.team, p);
      await fx.activate(p, w.team);
      await fx.admin.query(
        `UPDATE team_members SET role = 'team_admin' WHERE team_id = $1 AND user_id = $2`,
        [w.team, p.id],
      );
    }
    await fx.admin.query(
      `UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`,
      [w.team, former.id],
    );
    return { second, former };
  }

  it("tells each current Workspace admin once, in the bell; members and former admins get none", async () => {
    const w = await world();
    const { second, former } = await admins(w);
    const { id } = await expiringConnection(w);
    const first = await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(first.noticed).toBeGreaterThanOrEqual(1);
    const rows = await bellRows(w.team);
    expect(rows.map((r) => r.user_id).sort()).toEqual([w.admin.id, second.id].sort());
    expect(rows.every((r) => r.kind === "git.connection.token_expiring")).toBe(true);
    expect(rows.every((r) => r.git_connection_id === id)).toBe(true);
    // A second pass claims nothing; a repeated write for the same expiry is a no-op.
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    await fx.admin.query(`UPDATE git_connections SET expiry_notified_at = NULL WHERE id = $1`, [
      id,
    ]);
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(await bellRows(w.team)).toHaveLength(2);

    const listed = await call(w.admin, "GET", "/v1/notifications");
    expect(listed.status, listed.text).toBe(200);
    const note = listed.json.notifications.find(
      (n: { kind: string }) => n.kind === "git.connection.token_expiring",
    );
    expect(note).toMatchObject({
      kind: "git.connection.token_expiring",
      schedule_id: null,
      thread_id: null,
      run_id: null,
      git_connection_id: id,
      git_connection_name: expect.stringContaining(github.organization),
    });
    expect(Date.parse(note.git_expires_at as string)).toBeGreaterThan(Date.now());
    for (const p of [w.member, w.contributor, former]) {
      const theirs = await call(p, "GET", "/v1/notifications");
      expect(
        theirs.json.notifications.filter((n: { kind: string }) => n.kind.startsWith("git.")),
      ).toEqual([]);
    }
  });

  it("a process without a mail relay (the scheduler) claims nothing: bell and email wait", async () => {
    const w = await world();
    const { id } = await expiringConnection(w);
    const sent: unknown[] = [];
    const quiet = {
      db: fx.db,
      mailer: {
        disabled: true,
        send: (m: unknown) => Promise.resolve(void sent.push(m)),
        close: () => undefined,
      },
      publicUrl: "http://kobe.test",
      logger,
    };
    expect(await notifyGitTokenExpiry(quiet)).toBe(0);
    expect(sent).toEqual([]);
    expect(await bellRows(w.team)).toEqual([]);
    const { rows } = await fx.admin.query(
      `SELECT expiry_notified_at FROM git_connections WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.expiry_notified_at).toBeNull();
    // A process that can send then claims it: bell and email together.
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(await bellRows(w.team)).toMatchObject([{ user_id: w.admin.id, git_connection_id: id }]);
  });

  it("replacing the credential removes the old token's notices; a new expiry is noticed anew", async () => {
    const w = await world();
    const { id } = await expiringConnection(w);
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    const [old] = await bellRows(w.team);
    expect(old).toBeDefined();
    const later = new Date(Date.now() + 10 * 86_400_000);
    github.options = {
      patExpiration: `${later.toISOString().slice(0, 10)} ${later.toISOString().slice(11, 19)} UTC`,
    };
    const replaced = await call(w.admin, "PUT", `${BASE}/${id}/credential`, {
      credential: token(FAKE_PAT),
    });
    expect(replaced.status, replaced.text).toBe(200);
    // The old token's notice is gone at once, read or not.
    expect(await bellRows(w.team)).toEqual([]);
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    const rows = await bellRows(w.team);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.git_expires_at.getTime()).not.toBe(old?.git_expires_at.getTime());
    // A replacement token without an expiry leaves no notice at all.
    github.options = {};
    const again = await call(w.admin, "PUT", `${BASE}/${id}/credential`, {
      credential: token(FAKE_PAT),
    });
    expect(again.status, again.text).toBe(200);
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(await bellRows(w.team)).toEqual([]);
  });

  it("is deleted with the connection", async () => {
    const w = await world();
    const { id } = await expiringConnection(w);
    await runGitHealthPass(healthDeps(), new GitHostBackoff());
    expect(await bellRows(w.team)).toHaveLength(1);
    const res = await call(w.admin, "DELETE", `${BASE}/${id}`);
    expect(res.status, res.text).toBeLessThan(300);
    expect(await bellRows(w.team)).toEqual([]);
  });
});

describe("credential material never leaves the server (ac-2)", () => {
  it("is in no answer, audit row, email or log line, and the audit chain verifies", async () => {
    const { rows } = await fx.admin.query<{ credential_sealed: string; credential_key_id: string }>(
      `SELECT credential_sealed, credential_key_id FROM git_connections`,
    );
    const { rows: audit } = await fx.admin.query(
      `SELECT target FROM audit_log WHERE action LIKE 'git.%'`,
    );
    const text = [...seen, ...logged, JSON.stringify(audit)].join("\n");
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [FAKE_GITEA_TOKEN, FAKE_PAT, PEM_LINE, "BEGIN RSA PRIVATE KEY"]) {
      expect(text).not.toContain(secret);
    }
    for (const r of rows.filter(
      (x) => x.credential_sealed.startsWith("e1.") && !x.credential_key_id.startsWith("seed"),
    )) {
      expect(text).not.toContain(r.credential_sealed);
      expect(text).not.toContain(`"${r.credential_key_id}"`);
    }
    expect((await verifyAuditChain(fx.db)).ok).toBe(true);
  });
});
