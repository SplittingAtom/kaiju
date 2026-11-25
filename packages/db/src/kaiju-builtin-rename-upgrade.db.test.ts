import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, verifyAuditChain } from "./audit/index.js";
import { createDb } from "./client.js";
import {
  readBuiltinRenames,
  readKaijuMcpMode,
  seedGitBuiltinConnector,
  seedKaijuBuiltinConnector,
} from "./connectors/builtin.js";
import { runMigrations } from "./migrate.js";
import {
  GIT_BUILTIN_CONNECTOR_ID,
  GIT_BUILTIN_CONNECTOR_URL,
  KAIJU_BUILTIN_CONNECTOR_ID,
  KAIJU_BUILTIN_CONNECTOR_URL,
} from "./schema/index.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-826 (RN-13) as an upgrade runs it (the owner role) over populated databases: the built-in
 * connectors take their new names and every stored reference follows (ac-1). Two sites: one with
 * the built-ins under their usual names, one where registered connectors hold `kobe` (so the
 * built-in was `kobe-builtin`), `kaiju` and `kaiju-git` (so the new names fall back). Registered
 * connectors' rows and tools never change; history (audit, decided approvals) keeps the old names;
 * pending approvals of an old name fall due; FORCE RLS and the version triggers are back on.
 */
const MARKER = "-- KOBE-826 (rename step RN-13";

const OLD_KAIJU_URL = "http://kobe-server.internal/internal/v1/mcp/kobe";
const OLD_GIT_URL = "http://kobe-server.internal/internal/v1/mcp/git";

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Shape {
  /** The built-in Kaiju row's name before the upgrade. */
  readonly kaijuName: string;
  /** Registered connectors (name → id) besides `jira`. */
  readonly registered: readonly string[];
}

interface Site {
  readonly db: TestDatabase;
  readonly ids: Record<string, string>;
  /** Registered connector ids by name. */
  readonly connectors: Map<string, string>;
}

let older = "";
const sites: Site[] = [];

async function populate(db: TestDatabase, shape: Shape): Promise<Site> {
  const ids = {
    user: randomUUID(),
    other: randomUUID(),
    team: randomUUID(),
    otherTeam: randomUUID(),
    thread: randomUUID(),
    run: randomUUID(),
    teamAgent: randomUUID(),
    personal: randomUUID(),
    pendingOld: randomUUID(),
    pendingJira: randomUUID(),
    deniedOld: randomUUID(),
  };
  const connectors = new Map<string, string>();
  const seg = shape.kaijuName.replace(/-/g, "_");
  const old = `mcp__${seg}__`;
  await withClient(db.adminUrl, async (c) => {
    for (const [id, email] of [
      [ids.user, "u"],
      [ids.other, "o"],
    ] as const)
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `${email}-${id.slice(0, 8)}@upgrade.test`,
      ]);
    await c.query(
      `INSERT INTO teams (id, slug, name, settings) VALUES
         ($1, $2, 'A', '{"kobe_mcp.admin": "read_write", "other": 1}'),
         ($3, $4, 'B', '{"kobe_mcp.admin": "read"}')`,
      [ids.team, `a${ids.team.slice(0, 8)}`, ids.otherTeam, `b${ids.otherTeam.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'), ($3, $4, 'member')`,
      [ids.team, ids.user, ids.otherTeam, ids.other],
    );
    for (const name of ["jira", ...shape.registered]) {
      const id = randomUUID();
      connectors.set(name, id);
      await c.query(
        `INSERT INTO connectors (id, name, url, created_by) VALUES ($1, $2, 'https://mcp.example.test/mcp', $3)`,
        [id, name, ids.user],
      );
    }
    // The built-in rows as the server of the release before seeded them.
    await c.query(
      `INSERT INTO connectors (id, name, url, auth_kind, credential_source, builtin) VALUES
         ($1, $2, $3, 'none', 'member', 'kobe'), ($4, 'kobe-git', $5, 'none', 'member', 'git')`,
      [
        KAIJU_BUILTIN_CONNECTOR_ID,
        shape.kaijuName,
        OLD_KAIJU_URL,
        GIT_BUILTIN_CONNECTOR_ID,
        OLD_GIT_URL,
      ],
    );
    await c.query(
      `INSERT INTO site_settings (key, value) VALUES
         ('kobe_mcp.mode', 'admin'), ('kobe_mcp.reads_per_minute', '7'),
         ('kobe_mcp.writes_per_hour', '3'), ('unrelated', 'x')`,
    );
    await c.query(
      `INSERT INTO site_tool_rules (effect, tool_glob, created_by) VALUES
         ('deny', $1, $3), ('ask', 'mcp__jira__*', $3), ('deny', $2, $3)`,
      [`${old}site_*`, "mcp__kobe__team_members_*", ids.user],
    );
    await c.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by,
         remember_scope, exact_keys, exact_input) VALUES
         ($1, 'team', NULL, 'ask', 'mcp__kobe_git__git_push', $2, NULL, false, NULL),
         ($1, 'user', $2, 'allow', $3, $2, 'forever', true, '{"name":"x"}'),
         ($1, 'team', NULL, 'deny', 'mcp__kobe__*', $2, NULL, false, NULL),
         ($4, 'user', $5, 'allow', $6, $5, 'forever', false, NULL)`,
      [ids.team, ids.user, `${old}docs_page`, ids.otherTeam, ids.other, `${old}team_*`],
    );
    await c.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_tools, enabled_by)
       VALUES ($1, $2, 'custom', $3, $4)`,
      [
        ids.team,
        connectors.get("jira"),
        ["mcp__jira__a", `${old}docs_index`, "mcp__kobe__x"],
        ids.user,
      ],
    );
    const frontmatter = JSON.stringify({
      name: "A",
      connectors: [shape.kaijuName, "kobe-git", "jira"],
      tools: {
        allow: [`${old}*`, "read", "mcp__kobe_git__git_create_branch"],
        deny: [`${old}site_*`],
      },
    });
    await c.query(
      `INSERT INTO team_agents (team_id, id, owner_user_id, slug, frontmatter)
       VALUES ($1, $2, $3, 'agent', $4)`,
      [ids.team, ids.teamAgent, ids.user, frontmatter],
    );
    await c.query(
      `INSERT INTO site_agents (id, scope, owner_user_id, slug, frontmatter)
       VALUES ($1, 'personal', $2, 'mine', $3)`,
      [
        ids.personal,
        ids.user,
        JSON.stringify({ name: "M", connectors: "all", tools: { deny: [`${old}docs_full`] } }),
      ],
    );
    const manifest = JSON.stringify({
      format: 1,
      floor: "team",
      tools: [{ name: "read", source: "pi", risk: "read", scope: "sandbox", open_world: false }],
      connectors: [shape.kaijuName, "jira"],
      tools_allow: [`${old}*`, "read"],
      tools_deny: [`${old}site_*`],
      excluded: [],
      approval_mode: { requested: null, floor: "ask-on-write", effective: "ask-on-write" },
    });
    await c.query(
      `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
         tool_manifest, published_by, draft_revision, skill_manifest)
       VALUES ($1, $2, 1, $3, 'Use mcp__kobe__docs_index.', $4, $5, 1, '{"skills": []}')`,
      [ids.team, ids.teamAgent, frontmatter, manifest, ids.user],
    );
    await c.query(
      `INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest,
         published_by, draft_revision) VALUES ($1, 1, $2, 'p', $3, $4, 1)`,
      [ids.personal, JSON.stringify({ name: "M", connectors: "all" }), manifest, ids.user],
    );
    await c.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 'T')`,
      [ids.team, ids.thread, ids.user],
    );
    await c.query(
      `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'user', 'waiting_approval', now())`,
      [ids.team, ids.run, ids.thread],
    );
    const approval = (id: string, tool: string, status: string, call: string) =>
      c.query(
        `INSERT INTO approvals (team_id, id, run_id, thread_id, connection_id, user_id, tool_call_id,
           tool, input_canonical, risk, reasons, status, cause, decided_by, decided_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', 'write',
           '[{"code":"kobe_admin_write","stage":"ask_rule","message":"m"}]', $9::approval_status,
           CASE WHEN $9 = 'pending' THEN NULL ELSE 'user' END,
           CASE WHEN $9 = 'pending' THEN NULL ELSE $6::uuid END,
           CASE WHEN $9 = 'pending' THEN NULL ELSE now() END,
           now() + interval '1 hour')`,
        [ids.team, id, ids.run, ids.thread, randomUUID(), ids.user, call, tool, status],
      );
    await approval(ids.pendingOld, `${old}team_members_set_role`, "pending", "c1");
    await approval(ids.pendingJira, "mcp__jira__create_issue", "pending", "c2");
    await approval(ids.deniedOld, `${old}team_members_set_role`, "denied", "c3");
  });
  const app = createDb(db.appUrl);
  try {
    await app.db.transaction((tx) =>
      audit(tx, {
        action: "site.settings.updated",
        actor: { kind: "user", id: ids.user },
        target: { setting: "kobe_mcp_mode", value: "admin" },
      }),
    );
  } finally {
    await app.close();
  }
  return { db, ids, connectors };
}

const SHAPES: readonly Shape[] = [
  { kaijuName: "kobe", registered: [] },
  { kaijuName: "kobe-builtin", registered: ["kobe", "kaiju", "kaiju-git"] },
];

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  for (const shape of SHAPES) {
    const db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
    sites.push(await populate(db, shape));
  }
  for (const site of sites) {
    await runMigrations({ databaseUrl: site.db.ownerUrl, appRole: site.db.appRole });
    // Again: the migrate job of every release runs them all; a second run changes nothing.
    await runMigrations({ databaseUrl: site.db.ownerUrl, appRole: site.db.appRole });
  }
}, 240_000);

afterAll(async () => {
  for (const site of sites) await site.db.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

const site = (i: number): Site => {
  const s = sites[i];
  if (!s) throw new Error("site not created");
  return s;
};

const admin = <T>(i: number, fn: (c: pg.Client) => Promise<T>) =>
  withClient(site(i).db.adminUrl, fn);

const column = async (i: number, query: string, params: unknown[] = []) =>
  admin(i, async (c) => (await c.query(query, params)).rows);

describe.each([
  { i: 0, kaiju: "kaiju", git: "kaiju-git", old: "mcp__kobe__", now: "mcp__kaiju__" },
  {
    i: 1,
    kaiju: "kaiju-builtin",
    git: "kaiju-git-builtin",
    old: "mcp__kobe_builtin__",
    now: "mcp__kaiju_builtin__",
  },
])("upgrading a site whose built-in became $kaiju (KOBE-826)", ({ i, kaiju, git, old, now }) => {
  it("renames the built-in rows, keeps their ids and leaves registered connectors alone", async () => {
    const rows = await column(i, `SELECT id, name, url, builtin FROM connectors ORDER BY name`);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          id: KAIJU_BUILTIN_CONNECTOR_ID,
          name: kaiju,
          url: KAIJU_BUILTIN_CONNECTOR_URL,
          builtin: "kaiju",
        },
        { id: GIT_BUILTIN_CONNECTOR_ID, name: git, url: GIT_BUILTIN_CONNECTOR_URL, builtin: "git" },
      ]),
    );
    for (const [name, id] of site(i).connectors)
      expect(rows).toContainEqual({ id, name, url: "https://mcp.example.test/mcp", builtin: null });
    // The server's seeds find the renamed rows.
    const app = createDb(site(i).db.appUrl);
    try {
      expect(await seedKaijuBuiltinConnector(app.db)).toEqual({ outcome: "present", name: kaiju });
      expect(await seedGitBuiltinConnector(app.db)).toEqual({ outcome: "present", name: git });
      expect(await readKaijuMcpMode(app.db)).toBe("admin");
      expect(await readBuiltinRenames(app.db)).toEqual({
        segments: {
          [old.slice(5, -2)]: now.slice(5, -2),
          kobe_git: git.replace(/-/g, "_"),
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rewrites the built-ins' tool names in rules and remembered approvals, nothing else", async () => {
    const site_ = await column(
      i,
      `SELECT effect, tool_glob FROM site_tool_rules ORDER BY tool_glob`,
    );
    expect(site_.map((r) => r.tool_glob).sort()).toEqual(
      [
        `${now}site_*`,
        "mcp__jira__*",
        // A registered `kobe` connector's tools (site 1) keep their name; site 0's built-in moved.
        i === 0 ? "mcp__kaiju__team_members_*" : "mcp__kobe__team_members_*",
      ].sort(),
    );
    const team = await column(
      i,
      `SELECT team_id, scope, tool_glob, remember_scope, exact_keys, exact_input FROM tool_rules`,
    );
    const { ids } = site(i);
    expect(team).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          team_id: ids.team,
          tool_glob: `mcp__${git.replace(/-/g, "_")}__git_push`,
        }),
        // The remembered approval: same scope, keys and input, under the new name (ac-2).
        {
          team_id: ids.team,
          scope: "user",
          tool_glob: `${now}docs_page`,
          remember_scope: "forever",
          exact_keys: true,
          exact_input: '{"name":"x"}',
        },
        expect.objectContaining({ team_id: ids.otherTeam, tool_glob: `${now}team_*` }),
        expect.objectContaining({
          team_id: ids.team,
          tool_glob: i === 0 ? "mcp__kaiju__*" : "mcp__kobe__*",
        }),
      ]),
    );
    const [enabled] = await column(i, `SELECT enabled_tools FROM team_connectors`);
    expect(enabled?.enabled_tools).toEqual([
      "mcp__jira__a",
      `${now}docs_index`,
      i === 0 ? "mcp__kaiju__x" : "mcp__kobe__x",
    ]);
  });

  it("rewrites agent drafts and published versions' tool lists and connector names", async () => {
    const gitSeg = `mcp__${git.replace(/-/g, "_")}__`;
    const [draft] = await column(i, `SELECT frontmatter FROM team_agents`);
    expect(draft?.frontmatter).toEqual({
      name: "A",
      connectors: [kaiju, git, "jira"],
      tools: { allow: [`${now}*`, "read", `${gitSeg}git_create_branch`], deny: [`${now}site_*`] },
    });
    const [personal] = await column(i, `SELECT frontmatter FROM site_agents`);
    expect(personal?.frontmatter).toEqual({
      name: "M",
      connectors: "all",
      tools: { deny: [`${now}docs_full`] },
    });
    for (const table of ["team_agent_versions", "site_agent_versions"]) {
      const [v] = await column(i, `SELECT frontmatter, tool_manifest, prompt FROM ${table}`);
      expect(v?.tool_manifest).toMatchObject({
        connectors: [kaiju, "jira"],
        tools_allow: [`${now}*`, "read"],
        tools_deny: [`${now}site_*`],
        tools: [{ name: "read", source: "pi", risk: "read", scope: "sandbox", open_world: false }],
      });
    }
    const [team] = await column(i, `SELECT frontmatter, prompt FROM team_agent_versions`);
    expect(team?.frontmatter).toEqual(draft?.frontmatter);
    // Free text is the builder's own: never rewritten.
    expect(team?.prompt).toBe("Use mcp__kobe__docs_index.");
    // Versions are immutable again.
    await expect(
      admin(i, (c) => c.query(`UPDATE team_agent_versions SET prompt = 'x'`)),
    ).rejects.toThrow(/immutable/);
    await expect(
      admin(i, (c) => c.query(`UPDATE site_agent_versions SET prompt = 'x'`)),
    ).rejects.toThrow(/immutable/);
  });

  it("moves the settings keys, site and team", async () => {
    const settings = await column(i, `SELECT key, value FROM site_settings ORDER BY key`);
    expect(settings).toEqual(
      expect.arrayContaining([
        { key: "kaiju_mcp.mode", value: "admin" },
        { key: "kaiju_mcp.reads_per_minute", value: "7" },
        { key: "kaiju_mcp.writes_per_hour", value: "3" },
        { key: "unrelated", value: "x" },
      ]),
    );
    expect(settings.filter((r) => String(r.key).startsWith("kobe_mcp."))).toEqual([]);
    const teams = await column(i, `SELECT id, settings FROM teams ORDER BY slug`);
    expect(teams).toEqual([
      { id: site(i).ids.team, settings: { "kaiju_mcp.admin": "read_write", other: 1 } },
      { id: site(i).ids.otherTeam, settings: { "kaiju_mcp.admin": "read" } },
    ]);
  });

  it("makes pending approvals of an old name due, and keeps history as it was", async () => {
    const { ids } = site(i);
    const rows = await column(
      i,
      `SELECT id, tool, status, reasons, expires_at <= now() AS due FROM approvals ORDER BY tool_call_id`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: ids.pendingOld,
        tool: `${old}team_members_set_role`,
        status: "pending",
        due: true,
      }),
      expect.objectContaining({
        id: ids.pendingJira,
        tool: "mcp__jira__create_issue",
        status: "pending",
        due: false,
      }),
      expect.objectContaining({
        id: ids.deniedOld,
        tool: `${old}team_members_set_role`,
        status: "denied",
        due: false,
      }),
    ]);
    expect(rows[0]?.reasons).toEqual([
      { code: "kobe_admin_write", stage: "ask_rule", message: "m" },
    ]);
    const app = createDb(site(i).db.appUrl);
    try {
      expect((await verifyAuditChain(app.db)).ok).toBe(true);
    } finally {
      await app.close();
    }
    const auditRows = await column(
      i,
      `SELECT target FROM audit_log WHERE action = 'site.settings.updated'`,
    );
    expect(auditRows).toEqual([{ target: { setting: "kobe_mcp_mode", value: "admin" } }]);
  });

  it("puts FORCE row level security and the version triggers back", async () => {
    const force = await column(
      i,
      `SELECT relname, relforcerowsecurity AS f FROM pg_class
        WHERE relname = ANY($1) ORDER BY relname`,
      [["approvals", "team_agent_versions", "team_agents", "team_connectors", "tool_rules"]],
    );
    expect(force.every((r) => r.f === true)).toBe(true);
    expect(force).toHaveLength(5);
    const triggers = await column(
      i,
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE '%agent_versions_immutable'`,
    );
    expect(triggers.map((t) => t.tgenabled)).toEqual(["O", "O"]);
    const helpers = await column(i, `SELECT proname FROM pg_proc WHERE proname LIKE 'kaiju_826_%'`);
    expect(helpers).toEqual([]);
  });
});

describe("a fresh install (KOBE-826)", () => {
  it("has nothing to rename: the server seeds kaiju and kaiju-git", async () => {
    const db = await createTestDatabase(testServerUrl());
    try {
      const app = createDb(db.appUrl);
      try {
        expect(await readBuiltinRenames(app.db)).toEqual({ segments: {} });
        expect(await seedKaijuBuiltinConnector(app.db)).toEqual({
          outcome: "seeded",
          name: "kaiju",
          fallback: false,
        });
        expect(await seedGitBuiltinConnector(app.db)).toEqual({
          outcome: "seeded",
          name: "kaiju-git",
          fallback: false,
        });
      } finally {
        await app.close();
      }
    } finally {
      await db.drop();
    }
  }, 120_000);
});
