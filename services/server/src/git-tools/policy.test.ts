import { describe, expect, it } from "vitest";
import { GIT_BUILTIN_CONNECTOR_ID, type ToolDescriptor } from "@kobe/protocol";
import { evaluatePolicy } from "../policy/evaluate.js";
import { isKobeAdminTool, guardKobeAdmin } from "../policy/kobe-admin-guard.js";
import type { PolicyRule } from "../policy/rules.js";
import { DEFAULT_POLICY_SETTINGS } from "../policy/settings.js";
import { describePinnedTool } from "../mcp/catalog.js";
import { gitPinnedTools } from "./pinned.js";
import {
  NOW,
  policyInput,
  rule as makeRule,
  ruleSet,
  type InputOptions,
} from "../testing/policy-fixtures.js";
import { GIT_TOOLS, gitToolByName } from "./catalog.js";

/**
 * KOBE-762 (GQ3, G9; ac-1): the git host tools' default decisions through the ordinary policy
 * engine: reads allowed, `git_create_branch` allowed, the four other writes ask in interactive runs
 * and are denied unattended unless allow-listed; rules change the defaults as for any tool; the
 * Kaiju admin guard leaves them alone.
 */
const CONN = "55555555-0000-4000-8000-000000000005";

const pinned = gitPinnedTools("kobe");
function descriptor(name: string): ToolDescriptor {
  const tool = pinned.find((t) => t.name === name);
  if (!tool) throw new Error(name);
  return describePinnedTool(GIT_BUILTIN_CONNECTOR_ID, tool);
}

function decide(
  name: string,
  args: Record<string, unknown>,
  o: InputOptions & { rules?: PolicyRule[] } = {},
) {
  const tool = descriptor(name);
  return evaluatePolicy({
    input: policyInput(tool, args as never, { exposure: "custom", ...o }),
    tool,
    rules: ruleSet(o.rules ?? []),
    connector: {
      enabled: true,
      exposure: "custom",
      enabled_tools: pinned.map((t) => t.pi_name),
      drifted_tools: [],
    },
    settings: DEFAULT_POLICY_SETTINGS,
    now: NOW,
  });
}

const rule = (scope: "team" | "user", effect: "allow" | "ask" | "deny", tool: string) =>
  makeRule(scope, effect, `mcp__kobe__${tool}`);

const PR = {
  connection: CONN,
  repository: "docs",
  title: "Change",
  body: "Body",
  head: "feature",
  base: "main",
};

describe("default decisions (GQ3, G9)", () => {
  it("allows reads", () => {
    expect(decide("git_list_repositories", {}).effect).toBe("allow");
    expect(decide("git_read_file", { repository: "docs", path: "README.md" }).effect).toBe("allow");
  });

  it.each([
    ["git_create_repository", { connection: CONN, name: "new" }],
    ["git_open_pull_request", PR],
    ["git_comment", { connection: CONN, repository: "docs", number: 1, on: "issue", body: "x" }],
    ["git_create_issue", { connection: CONN, repository: "docs", title: "t", body: "b" }],
  ])("%s asks for approval in an interactive run", (name, args) => {
    const d = decide(name, args);
    expect(d.effect).toBe("require_approval");
    expect(d.reasons[0]?.code).toBe("risk_write");
  });

  it("allows git_create_branch without asking", () => {
    const d = decide("git_create_branch", {
      connection: CONN,
      repository: "docs",
      name: "kobe/x",
      from: "main",
    });
    expect(d).toMatchObject({ effect: "allow" });
    expect(d.reasons[0]?.message).toContain("creates a branch");
  });

  it("asks before every call in ask-all, reads included", () => {
    expect(decide("git_list_repositories", {}, { mode: "ask-all" }).effect).toBe(
      "require_approval",
    );
  });

  it("denies the writes where nobody can be asked, unless the team allow-lists them", () => {
    expect(decide("git_open_pull_request", PR, { mode: "auto" }).effect).toBe("deny");
    expect(decide("git_open_pull_request", PR, { kind: "schedule" }).effect).toBe("deny");
    expect(decide("git_list_repositories", {}, { kind: "schedule" }).effect).toBe("allow");
    // L1: creating a branch does not ask, but unattended runs still need an allow rule for it.
    const branch = { connection: CONN, repository: "docs", name: "x", from: "main" };
    expect(decide("git_create_branch", branch, { kind: "schedule" }).effect).toBe("deny");
    expect(decide("git_create_branch", branch, { mode: "auto" }).effect).toBe("deny");
    const listed = decide("git_open_pull_request", PR, {
      kind: "schedule",
      rules: [rule("team", "allow", "git_open_pull_request")],
    });
    expect(listed.effect).toBe("allow");
  });
});

describe("rules change the defaults as for any tool", () => {
  it("a team ask rule makes git_create_branch ask; a deny rule denies a read", () => {
    const args = { connection: CONN, repository: "docs", name: "x", from: "main" };
    expect(
      decide("git_create_branch", args, { rules: [rule("team", "ask", "git_create_branch")] })
        .effect,
    ).toBe("require_approval");
    expect(
      decide(
        "git_list_repositories",
        {},
        { rules: [rule("team", "deny", "git_list_repositories")] },
      ).effect,
    ).toBe("deny");
  });

  it("the member's remembered approval lifts the prompt (D29); a team allow rule does not (D6)", () => {
    const user = [rule("user", "allow", "git_open_pull_request")];
    expect(decide("git_open_pull_request", PR, { rules: user }).effect).toBe("allow");
    expect(
      decide("git_open_pull_request", PR, {
        rules: [rule("team", "allow", "git_open_pull_request")],
      }).effect,
    ).toBe("require_approval");
  });
});

describe("the Kaiju admin guard does not apply", () => {
  it("git tools are not Kaiju admin tools: no forced ask, not denied in scheduled runs", () => {
    for (const t of GIT_TOOLS) expect(isKobeAdminTool(descriptor(t.name))).toBe(false);
    const tool = descriptor("git_create_branch");
    const allowed = decide("git_create_branch", {
      connection: CONN,
      repository: "docs",
      name: "x",
      from: "main",
    });
    const guarded = guardKobeAdmin(allowed, {
      tool,
      input: policyInput(tool, {}, { kind: "schedule", exposure: "custom" }),
      evalRun: false,
      now: NOW,
    });
    expect(guarded).toBe(allowed);
  });

  it("annotates the tools as open world, writes never destructive", () => {
    for (const t of GIT_TOOLS) {
      const p = pinned.find((x) => x.name === t.name);
      expect(p?.annotations).toMatchObject({ openWorldHint: true, readOnlyHint: t.readOnly });
      if (!t.readOnly) expect(p?.annotations.destructiveHint).toBe(false);
      expect(descriptor(t.name).risk).toBe(t.readOnly ? "read" : "write");
    }
  });
});

describe("inputs", () => {
  const parse = (name: string, args: unknown) => gitToolByName(name)?.input.safeParse(args).success;

  it("are strict, and every write names its connection", () => {
    expect(parse("git_open_pull_request", { ...PR, extra: 1 })).toBe(false);
    const { connection: _c, ...noConnection } = PR;
    expect(parse("git_open_pull_request", noConnection)).toBe(false);
    expect(parse("git_create_repository", { name: "x" })).toBe(false);
    expect(parse("git_list_repositories", {})).toBe(true);
  });

  it("cap titles and bodies, and refuse public visibility", () => {
    expect(parse("git_open_pull_request", { ...PR, title: "t".repeat(257) })).toBe(false);
    expect(parse("git_open_pull_request", { ...PR, body: "b".repeat(20_001) })).toBe(false);
    expect(
      parse("git_create_issue", { connection: CONN, repository: "d", title: " ", body: "" }),
    ).toBe(false);
    expect(
      parse("git_create_repository", { connection: CONN, name: "x", visibility: "public" }),
    ).toBe(false);
    expect(parse("git_create_repository", { connection: CONN, name: "a/b" })).toBe(false);
  });

  it("names every tool git_<verb>", () => {
    for (const t of GIT_TOOLS) expect(t.name).toMatch(/^git_[a-z_]+$/);
  });
});
