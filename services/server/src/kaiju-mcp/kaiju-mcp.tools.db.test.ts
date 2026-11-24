import { describe, expect, it } from "vitest";
import { KAIJU_BUILTIN_CONNECTOR_ID, KAIJU_MCP_MODE_KEY } from "@kaiju/db";
import { KAIJU_BUILTIN_CONNECTOR_ID as PROTOCOL_KAIJU_ID } from "@kaiju/protocol";
import { llmsTxt, PAGES } from "@kaiju/guide";
import { withTeam } from "@kaiju/db";
import { kaijuRunServer } from "./run.js";
import { KAIJU_ADMIN_TOOLS } from "./tools/index.js";
import { PUBLIC_URL } from "../testing/event-stream-fixture.js";
import {
  fx,
  setSite,
  setLevel,
  world,
  sandboxFor,
  rpc,
  listNames,
  call,
  roleOf,
  DOCS,
  withDocs,
  pi,
  approve,
  decisions,
  useKaijuMcpWorld,
} from "./kaiju-mcp.test-helpers.js";

useKaijuMcpWorld();

describe("the built-in connector's identity", () => {
  it("has the same fixed id in @kaiju/db and @kaiju/protocol (the proxy routes by it)", () => {
    expect(PROTOCOL_KAIJU_ID).toBe(KAIJU_BUILTIN_CONNECTOR_ID);
  });
});

describe("listing follows the person's permission and both switches (ac-1, KA5)", () => {
  it("a member's sandbox lists no team-admin tool; a forged call is refused like a 403", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.member);
    expect(await listNames(s)).toEqual(withDocs());
    const forged = await call(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain("Kaiju denied this call");
    expect(forged.text).toContain("not available to you");
    expect(await roleOf(w.team, w.target.id)).toBe("member");
    expect((await decisions(w.team)).at(-1)).toMatchObject({
      decision: "denied",
      reason: "kobe_admin_not_allowed",
      connectorId: KAIJU_BUILTIN_CONNECTOR_ID,
    });
    // Even with an approval in hand (the member approved their own forged call).
    await approve(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    const approved = await call(s, "team_members_set_role", {
      user_id: w.target.id,
      from_role: "member",
      to_role: "team_admin",
    });
    expect(approved.isError).toBe(true);
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });

  it("a team admin lists by the team level: docs none, read the reads, read_write all", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.admin);
    expect(await listNames(s)).toEqual(withDocs()); // default: docs only (KA5)
    const team = KAIJU_ADMIN_TOOLS.filter((t) => t.scope === "team");
    await setLevel(w.team, "read");
    expect(await listNames(s)).toEqual(
      withDocs(...team.filter((t) => t.readOnly).map((t) => t.name)),
    );
    await setLevel(w.team, "read_write");
    expect(await listNames(s)).toEqual(withDocs(...team.map((t) => t.name)));
    // The site switch: docs hides every admin tool, off removes the connector.
    await setSite(KAIJU_MCP_MODE_KEY, "docs");
    expect(await listNames(s)).toEqual(withDocs());
    await setSite(KAIJU_MCP_MODE_KEY, null);
    expect(await listNames(s)).toEqual(withDocs());
    await setSite(KAIJU_MCP_MODE_KEY, "off");
    expect((await rpc(s, "tools/list")).status).toBe(403);
    const off = await rpc(s, "tools/call", { name: "team_members_list", arguments: {} });
    expect(off.status).toBe(403);
  });

  it("a level that does not include a tool refuses its call too", async () => {
    const w = await world("read");
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", input);
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });
});

describe("reads run freely, as the person", () => {
  it("lists the team's members, reduced to the output schema and paged", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const out = await call(s, "team_members_list", {});
    expect(out.isError).toBeUndefined();
    const members = (out.structured?.members ?? []) as { user_id: string; role: string }[];
    expect(members.map((m) => m.user_id).sort()).toEqual(
      [w.admin.id, w.member.id, w.target.id].sort(),
    );
    expect(Object.keys(members[0] ?? {}).sort()).toEqual(["email", "name", "role", "user_id"]);
    expect(out.structured?.next_cursor).toBeUndefined();
  });

  it("refuses a read in a scheduled run (docs tools only there)", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [s.runId]);
    const out = await call(s, "team_members_list", {});
    expect(out.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ reason: "kobe_admin_not_allowed" });
  });
});

describe("the docs tools (KOBE-620, KA-3; spec §4, KA4, KA7)", () => {
  const index = () => llmsTxt(PAGES, { appName: "Kaiju", origin: new URL(PUBLIC_URL).origin });

  it("docs_index equals /llms.txt for the deployment's origin and app name (ac-1)", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    const out = await call(s, "docs_index", {});
    expect(out.isError).toBeUndefined();
    expect(out.text).toBe(index());
    expect((await decisions(w.team)).at(-1)).toMatchObject({
      decision: "allowed",
      tool: pi("docs_index"),
      risk: "read",
    });
  });

  it("follows the site's app name", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    await setSite("branding.app_name", "Acme Chat");
    try {
      const out = await call(s, "docs_index", {});
      expect(out.text.startsWith("# Acme Chat\n")).toBe(true);
    } finally {
      await setSite("branding.app_name", null);
    }
  });

  it("docs_page returns a page; an unknown or traversing slug is a tool error (ac-2)", async () => {
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    const page = PAGES[0] as (typeof PAGES)[number];
    const out = await call(s, "docs_page", { slug: page.slug });
    expect(out.text.startsWith(`# ${page.title}\n`)).toBe(true);
    for (const slug of ["no-such-page", "../../../etc/passwd"]) {
      const bad = await call(s, "docs_page", { slug });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("unknown_page");
    }
    const search = await call(s, "docs_search", { query: "approvals" });
    expect((search.structured?.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("work in auto and scheduled runs and skill evals, with the site at docs and the team at docs only", async () => {
    await setSite(KAIJU_MCP_MODE_KEY, "docs");
    const w = await world(null);
    const s = await sandboxFor(w.team, w.member);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [s.runId]);
    expect((await call(s, "docs_index", {})).text).toBe(index());
    await fx.admin.query(`UPDATE runs SET trigger = 'schedule' WHERE id = $1`, [s.runId]);
    expect(await listNames(s)).toEqual(withDocs());
    expect((await call(s, "docs_index", {})).text).toBe(index());
    // An eval thread's flag never changes: set with triggers off (one statement batch).
    await fx.admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       UPDATE threads SET skill_eval = true WHERE id = '${s.threadId}'; COMMIT;`,
    );
    expect(await listNames(s)).toEqual(withDocs());
    expect((await call(s, "docs_index", {})).text).toBe(index());
  });

  it("need no permission and never count against the admin read limit", async () => {
    const w = await world("read");
    const s = await sandboxFor(w.team, w.admin);
    await setSite("kobe_mcp.reads_per_minute", "1");
    for (let i = 0; i < 3; i++) expect((await call(s, "docs_index", {})).isError).toBeUndefined();
    expect((await call(s, "team_members_list", {})).isError).toBeUndefined();
    expect((await call(s, "team_members_list", {})).isError).toBe(true);
    expect((await call(s, "docs_index", {})).isError).toBeUndefined();
  });

  it("attach to every run whatever the agent's connector list; admin tools follow it (KA7)", async () => {
    const w = await world("read_write");
    const names = (server: Awaited<ReturnType<typeof kaijuRunServer>>) =>
      (server?.tools ?? []).map((t) => t.name).sort();
    const runServer = (
      frontmatter: Parameters<typeof kaijuRunServer>[1]["frontmatter"],
      answerable = true,
      off: ReadonlySet<string> = new Set(),
    ) =>
      withTeam(fx.db, w.team, (tx) =>
        kaijuRunServer(tx, { teamId: w.team, userId: w.admin.id, answerable, frontmatter, off }),
      );
    const agent = (extra: Record<string, unknown> = {}) =>
      ({ name: "A", role: "r", description: "d", ...extra }) as never;
    // No connectors named, no agent at all, a scheduled run: docs tools only.
    expect(names(await runServer(agent()))).toEqual(DOCS);
    expect(names(await runServer(undefined))).toEqual(DOCS);
    expect(names(await runServer(agent({ connectors: "all" }), false))).toEqual(DOCS);
    // Naming the connector adds the admin tools the person may use.
    expect(names(await runServer(agent({ connectors: "all" })))).toEqual(
      withDocs(...KAIJU_ADMIN_TOOLS.filter((t) => t.scope === "team").map((t) => t.name)),
    );
    // The agent's tool globs still apply; the thread's off switch and the site's off remove all.
    expect(names(await runServer(agent({ tools: { deny: [`${pi("docs_full")}`] } })))).toEqual(
      DOCS.filter((d) => d !== "docs_full"),
    );
    expect(await runServer(agent(), true, new Set([KAIJU_BUILTIN_CONNECTOR_ID]))).toBeUndefined();
    await setSite(KAIJU_MCP_MODE_KEY, "off");
    expect(await runServer(agent())).toBeUndefined();
  });
});

describe("writes ask in every mode (ac-2, ac-3) and run exactly what was approved (ac-4)", () => {
  it("denies a write without a verified approval, runs it once with one, denies the replay", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    const input = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    const without = await call(s, "team_members_set_role", input);
    expect(without.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({
      decision: "denied",
      approvalFailure: "no_approval",
    });
    expect(await roleOf(w.team, w.target.id)).toBe("member");

    const approval = await approve(s, "team_members_set_role", input);
    const once = await call(s, "team_members_set_role", input, approval.toolCallId);
    expect(once.isError).toBeUndefined();
    expect(once.structured).toEqual({ user_id: w.target.id, role: "contributor" });
    expect(await roleOf(w.team, w.target.id)).toBe("contributor");

    // The replay (same tool call id, then none) finds the approval consumed.
    const replay = await call(s, "team_members_set_role", input, approval.toolCallId);
    expect(replay.isError).toBe(true);
    expect((await call(s, "team_members_set_role", input)).isError).toBe(true);
    const consumed = await fx.admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE team_id = $1 AND action = 'approval.consumed'`,
      [w.team],
    );
    expect(consumed.rows[0]).toEqual({ n: 1 });
  });

  it("an allow rule (team allow-list, the user's remembered rule) never stands in for asking", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'allow', $3, $2)`,
      [w.team, w.admin.id, pi("team_members_set_role")],
    );
    const input = { user_id: w.target.id, from_role: "member", to_role: "team_admin" };
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ approvalFailure: "no_approval" });
    // In auto mode (where the team allow rule would allow any other write) it is denied outright.
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [s.runId]);
    await approve(s, "team_members_set_role", input);
    const auto = await call(s, "team_members_set_role", input);
    expect(auto.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ reason: "kobe_admin_write" });
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });

  it("refuses with changed_since_approval when the before-state moved; nothing changes", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    // The person approved "contributor → team admin", but the target is a member now.
    const input = { user_id: w.target.id, from_role: "contributor", to_role: "team_admin" };
    await approve(s, "team_members_set_role", input);
    const out = await call(s, "team_members_set_role", input);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("changed_since_approval");
    expect(await roleOf(w.team, w.target.id)).toBe("member");
  });

  it("caps writes per person per hour (site setting)", async () => {
    const w = await world();
    const s = await sandboxFor(w.team, w.admin);
    await setSite("kobe_mcp.writes_per_hour", "1");
    const first = { user_id: w.target.id, from_role: "member", to_role: "contributor" };
    await approve(s, "team_members_set_role", first);
    expect((await call(s, "team_members_set_role", first)).isError).toBeUndefined();
    const second = { user_id: w.target.id, from_role: "contributor", to_role: "member" };
    await approve(s, "team_members_set_role", second);
    const limited = await call(s, "team_members_set_role", second);
    expect(limited.isError).toBe(true);
    expect((await decisions(w.team)).at(-1)).toMatchObject({ reason: "kobe_admin_rate_limited" });
    expect(await roleOf(w.team, w.target.id)).toBe("contributor");
  });
});
