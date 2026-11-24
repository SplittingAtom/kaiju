import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GIT_BUILTIN_CONNECTOR_ID,
  KAIJU_BUILTIN_CONNECTOR_ID,
  KAIJU_MCP_MODE_KEY,
  GIT_SITE_ENABLED_KEY,
  verifyAuditChain,
  withTeam,
} from "@kaiju/db";
import { projectPermissions } from "@kaiju/protocol";
import { kaijuGitApprovalCard } from "./card.js";
import { guardGitToolCall } from "./guard.js";
import { describePinnedTool } from "../mcp/catalog.js";
import { gitPinnedTools } from "./pinned.js";
import { gitToolByName } from "./catalog.js";
import { GIT_CONNECTION_READS_PER_HOUR, runGitTool, type GitToolsDeps } from "./execute.js";
import { listChatConnectors } from "../connectors/thread-connectors.js";
import { hostHasRepos, repoReadRules } from "../git/transport.js";
import { FAKE_GITEA_TOKEN } from "../testing/fake-gitea.js";
import { FAKE_PAT } from "../testing/fake-github.js";
import {
  must,
  h,
  github,
  envelope,
  seen,
  type World,
  world,
  connect,
  gitNames,
  auditRows,
  call,
  approved,
  useGitToolsWorld,
} from "./git-tools.test-helpers.js";

useGitToolsWorld();

describe("the sandbox's policy.check refuses before anyone is asked", () => {
  it("denies a write the connection or role refuses, and lets policy decide the rest", async () => {
    const w = await world();
    const readOnly = await connect(w, "forgejo", "read");
    const rw = await connect(w, "gitea");
    const s = await h.sandboxFor(w.team, w.contributor);
    const tool = describePinnedTool(
      GIT_BUILTIN_CONNECTOR_ID,
      must(gitPinnedTools("kobe-git").find((t) => t.name === "git_create_issue")),
    );
    const ask = {
      effect: "require_approval" as const,
      risk: "write" as const,
      reasons: [{ code: "risk_write" as const, stage: "risk_class" as const, message: "asks" }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const who = { teamId: w.team, userId: w.contributor.id, sandboxId: s.sandboxId };
    const input = (connection: string) => ({
      connection,
      repository: "docs",
      title: "t",
      body: "",
    });
    const refused = await guardGitToolCall(h.fx.db, who, ask, tool, input(readOnly));
    expect(refused).toMatchObject({ effect: "deny", reasons: [{ code: "git_not_allowed" }] });
    expect(await guardGitToolCall(h.fx.db, who, ask, tool, input(rw))).toBe(ask);
    const malformed = await guardGitToolCall(h.fx.db, who, ask, tool, { ...input(rw), x: 1 });
    expect(malformed).toMatchObject({ effect: "deny", reasons: [{ code: "invalid_input" }] });
    const reader = { teamId: w.team, userId: w.reader.id, sandboxId: s.sandboxId };
    expect(await guardGitToolCall(h.fx.db, reader, ask, tool, input(rw))).toMatchObject({
      effect: "deny",
    });
  });

  it("builds a card only for the built-in connector's git tools", async () => {
    const w = await world();
    const id = await connect(w, "forgejo");
    const req = {
      teamId: w.team,
      userId: w.contributor.id,
      threadId: randomUUID(),
      publicUrl: "https://kaiju.test",
      input: { connection: id, repository: "docs", title: "t", body: "b" },
    };
    const card = await withTeam(h.fx.db, w.team, (tx) =>
      kaijuGitApprovalCard(tx, { ...req, piName: h.pi("git_create_issue") }),
    );
    expect(card).toMatchObject({ action: "create_issue", repository: "docs" });
    const lookalike = await withTeam(h.fx.db, w.team, (tx) =>
      kaijuGitApprovalCard(tx, { ...req, piName: "mcp__other__git_create_issue" }),
    );
    expect(lookalike).toBeUndefined();
  });
});

describe("a write whose outcome is unknown never acts twice (M1)", () => {
  const issue = (connection: string) => ({ connection, repository: "docs", title: "t", body: "b" });

  it("answers outcome_unknown after an attempt that ended without an answer", async () => {
    const w = await world();
    const id = await connect(w, "github");
    const s = await h.sandboxFor(w.team, w.contributor);
    github.failPostsOnly = true;
    github.fail("server_error");
    const first = await approved(s, "git_create_issue", issue(id));
    expect(first.out.text).toContain("host_unavailable");
    github.fail(null);
    const again = await approved(s, "git_create_issue", issue(id));
    expect(again.out.isError).toBe(true);
    expect(again.out.text).toContain("outcome_unknown");
    expect(github.issues).toEqual([]);
    const rows = await auditRows(w.team, "git.write");
    expect(rows.map((r) => r.action)).toEqual(["git.write.attempted"]);
    expect(rows[0]?.target).toMatchObject({ tool: "git_create_issue", repository: "docs" });
  });

  it("lets a call the host refused for certain be tried again", async () => {
    const w = await world();
    const id = await connect(w, "github");
    const s = await h.sandboxFor(w.team, w.contributor);
    github.failPostsOnly = true;
    github.fail("forbidden");
    expect((await approved(s, "git_create_issue", issue(id))).out.text).toContain(
      "credential_forbidden",
    );
    github.fail(null);
    const again = await approved(s, "git_create_issue", issue(id));
    expect(again.out.isError, again.out.text).toBeUndefined();
    expect(github.issues).toHaveLength(1);
    expect((await auditRows(w.team, "git.write")).map((r) => r.action)).toEqual([
      "git.write.attempted",
      "git.write.failed",
      "git.write.attempted",
    ]);
  });
});

describe("per-connection budget (M2)", () => {
  it("refuses once the connection's hourly budget is spent, with the retry time", async () => {
    const w = await world();
    const id = await connect(w, "gitea");
    const s = await h.sandboxFor(w.team, w.reader);
    await h.fx.admin.query(
      `INSERT INTO kobe_rate_limits (key, count, window_start, expires_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET count = $2, window_start = $3, expires_at = $4`,
      [
        `kobe:git-tools:connection:read:${id}`,
        GIT_CONNECTION_READS_PER_HOUR,
        Date.now(),
        Date.now() + 3_600_000,
      ],
    );
    const out = await call(s, "git_list_repositories", { connection: id });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("git_connection_budget");
    expect(out.text).toMatch(/Try again after \d{4}-/);
  });
});

describe("the git tools follow the Git switch, never the Kaiju connector's (M3)", () => {
  const kaijuMode = (mode: string | null) => h.setSite(KAIJU_MCP_MODE_KEY, mode);
  const gitSwitch = (on: boolean) => h.setSite(GIT_SITE_ENABLED_KEY, on ? null : "false");

  it.each([
    [true, "off", true],
    [true, "docs", true],
    [true, "admin", true],
    [false, "off", false],
    [false, "admin", false],
  ] as const)("Git switch %s, Kaiju MCP %s: git tools offered %s", async (git, mode, offered) => {
    const w = await world();
    const id = await connect(w, "forgejo");
    const s = await h.sandboxFor(w.team, w.contributor);
    await kaijuMode(mode);
    await gitSwitch(git);
    try {
      expect((await gitNames(s)).length > 0).toBe(offered);
      const out = await call(s, "git_list_repositories", { connection: id });
      expect(out.isError === true).toBe(!offered);
      const picker = await withTeam(h.fx.db, w.team, (tx) =>
        listChatConnectors(tx, { teamId: w.team, userId: w.contributor.id }, null),
      );
      expect(picker.some((c) => c.builtin?.kind === "git")).toBe(offered);
    } finally {
      await kaijuMode(null);
      await gitSwitch(true);
    }
  });

  it("keeps the git tools when the Kaiju connector is off in the conversation", async () => {
    const w = await world();
    const id = await connect(w, "gitea");
    const s = await h.sandboxFor(w.team, w.contributor);
    await h.fx.admin.query(
      `INSERT INTO thread_connectors_off (team_id, thread_id, connector_id) VALUES ($1, $2, $3)`,
      [w.team, s.threadId, KAIJU_BUILTIN_CONNECTOR_ID],
    );
    const out = await call(s, "git_list_repositories", { connection: id });
    expect(out.isError, out.text).toBeUndefined();
  });
});

describe("Kaiju Repos are read with a role on their project (M4)", () => {
  async function repoFor(w: World, connection: string, hostRepoId: string, fullName: string) {
    const project = randomUUID();
    await h.fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, kind, created_by)
       VALUES ($1, $2, $3, 'Docs', 'repo', $4)`,
      [w.team, project, `docs-${project.slice(0, 6)}`, w.admin.id],
    );
    await h.fx.admin.query(
      `INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name,
         project_id, origin, created_by)
       SELECT $1, id, base_url, $3, $4, $5, 'conversion', $6 FROM git_connections WHERE id = $2`,
      [w.team, connection, hostRepoId, fullName, project, w.admin.id],
    );
  }

  it("reads and lists a Repo for a member with a role on its project", async () => {
    const w = await world();
    const id = await connect(w, "github");
    // Matched by name here (the id is the fake's); rename and reconnect: transport tests.
    await repoFor(w, id, "1", `${github.organization}/docs`);
    const s = await h.sandboxFor(w.team, w.reader);
    const listed = JSON.parse((await call(s, "git_list_repositories", {})).text);
    expect(listed.repositories.map((r: { name: string }) => r.name)).toEqual(["docs"]);
    const file = await call(s, "git_read_file", { repository: "docs", path: "README.md" });
    expect(file.isError, file.text).toBeUndefined();
  });

  it("refuses a name the host cannot resolve while Repos exist, exactly as a missing one", async () => {
    const w = await world();
    const id = await connect(w, "github");
    await repoFor(w, id, "999999", `${github.organization}/gone`);
    const s = await h.sandboxFor(w.team, w.reader);
    const gone = await call(s, "git_read_file", { repository: "gone", path: "README.md" });
    const missing = await call(s, "git_read_file", { repository: "never", path: "README.md" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toBe(missing.text);
  });
});

describe("round 2 (review g103)", () => {
  it("R2-L1: finds a Repo's rule however many Repos the host has (no cap)", async () => {
    const w = await world();
    const id = await connect(w, "github");
    await h.fx.admin.query(
      `WITH p AS (
         INSERT INTO projects (team_id, id, slug, name, kind, created_by)
         SELECT $1, gen_random_uuid(), 'bulk-' || n, 'Bulk', 'repo', $2 FROM generate_series(1, 5001) n
         RETURNING id, slug)
       INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name,
         project_id, origin, created_by)
       SELECT $1, c.id, c.base_url, 'b' || p.slug, 'acme-test/' || p.slug, p.id, 'conversion', $2
         FROM p, git_connections c WHERE c.id = $3`,
      [w.team, w.admin.id, id],
    );
    const project = randomUUID();
    await h.fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, kind, created_by)
       VALUES ($1, $2, 'zz-last', 'Last', 'repo', $3)`,
      [w.team, project, w.admin.id],
    );
    await h.fx.admin.query(
      `INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name,
         project_id, origin, created_by)
       SELECT $1, id, base_url, 'zz-host-id', 'acme-test/zz-last', $2, 'conversion', $3
         FROM git_connections WHERE id = $4`,
      [w.team, project, w.admin.id, id],
    );
    const base = must(
      (
        await h.fx.admin.query<{ base_url: string }>(
          `SELECT base_url FROM git_connections WHERE id = $1`,
          [id],
        )
      ).rows[0],
    ).base_url;
    const principal = { teamId: w.team, userId: w.reader.id };
    expect(await hostHasRepos(h.fx.db, principal, base)).toBe(true);
    const rules = await repoReadRules(h.fx.db, principal, base, [
      { id: "zz-host-id", fullName: "elsewhere/renamed" },
    ]);
    expect(rules.map((r) => r.fullName)).toEqual(["acme-test/zz-last"]);
    const byName = await repoReadRules(h.fx.db, principal, base, [
      { id: "stale", fullName: "ACME-TEST/zz-last" },
    ]);
    expect(byName).toHaveLength(1);
  });

  it("R2-L3: a repository the host created but answered oddly is never recorded as failed", async () => {
    const w = await world();
    const id = await connect(w, "github");
    github.options = { createdOwner: "someone-else" };
    const s = await h.sandboxFor(w.team, w.contributor);
    const first = await approved(s, "git_create_repository", { connection: id, name: "odd" });
    expect(first.out.isError).toBe(true);
    const rows = (await auditRows(w.team, "git.write")).map((r) => r.action);
    expect(rows).toEqual(["git.write.attempted"]);
    const again = await approved(s, "git_create_repository", { connection: id, name: "odd" });
    expect(again.out.text).toContain("outcome_unknown");
    expect(github.createdRepositories).toHaveLength(1);
  });
});

describe("write tools apply the Repo read rule first (R2-L2)", () => {
  it("answers a Repo the member may not read exactly as a missing repository, sending nothing", async () => {
    const w = await world();
    const id = await connect(w, "github");
    const s = await h.sandboxFor(w.team, w.contributor);
    const docsId = JSON.parse(
      (await call(s, "git_get_repository", { connection: id, repository: "docs" })).text,
    );
    expect(docsId.repository.name).toBe("docs");
    const project = randomUUID();
    await h.fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, kind, created_by)
       VALUES ($1, $2, 'restricted', 'Restricted', 'repo', $3)`,
      [w.team, project, w.admin.id],
    );
    await h.fx.admin.query(
      `INSERT INTO git_repositories (team_id, connection_id, base_url, host_repo_id, full_name,
         project_id, origin, created_by)
       SELECT $1, id, base_url, 'unused-id', $2, $3, 'conversion', $4
         FROM git_connections WHERE id = $5`,
      [w.team, `${github.organization}/docs`, project, w.admin.id, id],
    );
    // A restricted reader, through the test seam (today every member reads every project).
    const deps: GitToolsDeps = {
      db: h.fx.db,
      envelope,
      net: h.fx.replica(0).deps.gitHostNet,
      publicUrl: "https://kaiju.test",
      projectPermissions: (role, projectRole) => ({
        ...projectPermissions(role, projectRole),
        view: false,
        converse: false,
        edit: false,
      }),
    };
    const ctx = {
      principal: { teamId: w.team, userId: w.contributor.id, sandboxId: s.sandboxId },
      runId: s.runId,
      threadId: s.threadId,
      toolCallId: "toolu_r2l2",
      agentId: null,
    };
    const run = (name: string, input: Record<string, unknown>) =>
      runGitTool(deps, ctx, must(gitToolByName(name)), input);
    const writes: [string, (repository: string) => Record<string, unknown>][] = [
      ["git_create_branch", (r) => ({ connection: id, repository: r, name: "x", from: "main" })],
      [
        "git_open_pull_request",
        (r) => ({ connection: id, repository: r, title: "t", body: "b", head: "x", base: "main" }),
      ],
      [
        "git_comment",
        (r) => ({ connection: id, repository: r, number: 1, on: "issue", body: "b" }),
      ],
      ["git_create_issue", (r) => ({ connection: id, repository: r, title: "t", body: "b" })],
    ];
    const missing = await run("git_create_issue", {
      connection: id,
      repository: "never",
      title: "t",
      body: "b",
    });
    for (const [name, input] of writes) {
      const refused = await run(name, input("docs"));
      expect(refused, name).toEqual(missing);
      expect(refused).toMatchObject({ ok: false, code: "not_found" });
    }
    // Reads too, and the listing leaves it out.
    expect(await run("git_read_file", { connection: id, repository: "docs", path: "" })).toEqual(
      missing,
    );
    const listed = await run("git_list_repositories", { connection: id });
    expect(listed.ok && JSON.parse(listed.text).repositories).toEqual([]);
    expect(await auditRows(w.team, "git.write")).toEqual([]);
    expect(github.issues).toEqual([]);
    expect(github.pullRequests).toEqual([]);
  });
});

describe("the record", () => {
  it("never holds a credential, and the audit chain verifies", async () => {
    expect(seen.join("\n")).not.toContain(FAKE_PAT);
    expect(seen.join("\n")).not.toContain(FAKE_GITEA_TOKEN);
    expect((await verifyAuditChain(h.fx.db)).ok).toBe(true);
  });
});
