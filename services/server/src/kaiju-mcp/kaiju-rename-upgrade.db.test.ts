import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  GIT_BUILTIN_CONNECTOR_ID,
  KAIJU_BUILTIN_CONNECTOR_ID,
  readBuiltinRenames,
  renamedBuiltinToolName,
  runMigrations,
  type KaijuDatabase,
} from "@kaiju/db";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "@kaiju/db/testing";
import type { PolicyDecision, PolicyEngine, ToolDescriptor } from "@kaiju/protocol";
import { createDbMcpCatalog } from "../mcp/catalog.js";
import { createPolicyEngine } from "../policy/engine.js";
import { createToolRegistry } from "../policy/registry.js";
import { createDbRuleSource, createDbSettingsSource } from "../policy/rule-store.js";
import { policyInput } from "../testing/policy-fixtures.js";
import { adminResultGate } from "../threads/admin-redaction.js";
import { kaijuBuiltinSegments } from "./access.js";

/**
 * KOBE-826 ac-2: a site upgraded from before the rename keeps its rules. A site deny rule and a
 * remembered approval written for the built-in tools' old names apply to the same tools under the
 * new names, through the server's own policy engine over the migrated database; a call by an old
 * name (a resumed thread's history) is refused and told the new name; shared threads still hide
 * old admin results.
 */
const MARKER = "-- KOBE-826 (rename step RN-13";

let db: TestDatabase | undefined;
let app: KaijuDatabase | undefined;
let older = "";
let engine: PolicyEngine;
const ids = { user: randomUUID(), team: randomUUID() };

async function asAdmin(url: string, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      ids.user,
      `u-${ids.user.slice(0, 8)}@upgrade.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
      ids.team,
      `t${ids.team.slice(0, 8)}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
      [ids.team, ids.user],
    );
    await c.query(
      `INSERT INTO connectors (id, name, url, auth_kind, credential_source, builtin) VALUES
         ($1, 'kobe', 'http://kobe-server.internal/internal/v1/mcp/kobe', 'none', 'member', 'kobe'),
         ($2, 'kobe-git', 'http://kobe-server.internal/internal/v1/mcp/git', 'none', 'member', 'git')`,
      [KAIJU_BUILTIN_CONNECTOR_ID, GIT_BUILTIN_CONNECTOR_ID],
    );
    await c.query(`INSERT INTO site_settings (key, value) VALUES ('kobe_mcp.mode', 'admin')`);
    await c.query(
      `INSERT INTO site_tool_rules (effect, tool_glob, created_by) VALUES ('deny', 'mcp__kobe__team_*', $1)`,
      [ids.user],
    );
    // "Approve and remember" for a git write that asks by default.
    await c.query(
      `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
       VALUES ($1, 'user', $2, 'allow', 'mcp__kobe_git__git_comment', $2, 'forever')`,
      [ids.team, ids.user],
    );
  });
  await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
  app = createDb(db.appUrl);
  const catalog = createDbMcpCatalog(app.db);
  const kaiju = app.db;
  engine = createPolicyEngine({
    rules: createDbRuleSource(app.db),
    settings: createDbSettingsSource(app.db),
    registry: createToolRegistry(catalog),
    connectors: catalog,
    renamed: async (name) => renamedBuiltinToolName(await readBuiltinRenames(kaiju), name),
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

const decide = (name: string, connectorId: string, risk: ToolDescriptor["risk"]) => {
  const tool: ToolDescriptor = {
    name,
    source: "mcp",
    connector_id: connectorId,
    risk,
    open_world: false,
    scope: "external",
  };
  const base = policyInput(tool);
  return engine.decide({
    ...base,
    team_id: ids.team,
    actor: { ...base.actor, user_id: ids.user },
  }) as Promise<PolicyDecision>;
};

describe("rules written before the rename (KOBE-826 ac-2)", () => {
  it("applies a site deny rule to the renamed Kaiju tools", async () => {
    const decision = await decide(
      "mcp__kaiju__team_members_list",
      KAIJU_BUILTIN_CONNECTOR_ID,
      "read",
    );
    expect(decision.effect).toBe("deny");
    expect(decision.reasons[0]?.code).toBe("site_deny_rule");
  });

  it("applies a remembered approval to the renamed git tool", async () => {
    const decision = await decide("mcp__kaiju_git__git_comment", GIT_BUILTIN_CONNECTOR_ID, "write");
    expect(decision.effect, JSON.stringify(decision)).toBe("allow");
    expect(decision.reasons[0]?.code).toBe("user_allow_rule");
    // Its neighbour, without a remembered approval, still asks.
    const other = await decide(
      "mcp__kaiju_git__git_create_issue",
      GIT_BUILTIN_CONNECTOR_ID,
      "write",
    );
    expect(other.effect).toBe("require_approval");
  });

  it("refuses an old name with the name to call instead, never mapping it", async () => {
    const decision = await decide("mcp__kobe__docs_index", KAIJU_BUILTIN_CONNECTOR_ID, "read");
    expect(decision).toEqual({
      effect: "deny",
      risk: "destructive",
      reasons: [
        {
          code: "unknown_tool",
          stage: "site_deny",
          message:
            "mcp__kobe__docs_index was renamed to mcp__kaiju__docs_index in an upgrade; call " +
            "mcp__kaiju__docs_index instead.",
        },
      ],
    });
    const git = await decide("mcp__kobe_git__git_comment", GIT_BUILTIN_CONNECTOR_ID, "write");
    expect(git.reasons[0]?.message).toContain("call mcp__kaiju_git__git_comment instead");
    const unknown = await decide("mcp__nothing__x", KAIJU_BUILTIN_CONNECTOR_ID, "read");
    expect(unknown.reasons[0]?.message).toBe("mcp__nothing__x is not a known tool.");
  });

  it("keeps hiding old admin results from readers of shared threads", async () => {
    if (!app) throw new Error("no app");
    const segments = await kaijuBuiltinSegments(app.db);
    expect(segments).toEqual(["kaiju", "kobe"]);
    const gate = adminResultGate({ segments, teamRole: "member", siteRole: null });
    expect(gate.hides("mcp__kobe__team_members_set_role")).toBe(true);
    expect(gate.hides("mcp__kaiju__team_members_set_role")).toBe(true);
    expect(gate.hides("mcp__kobe__docs_index")).toBe(false);
  });
});
