import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMEMBER_LIMITS,
  matchGlob,
  type JsonObject,
  type PolicyDecision,
  type RememberLimits,
  type ToolDescriptor,
} from "@kaiju/protocol";
import {
  builtin,
  ENABLED_ALL,
  IDS,
  mcpTool,
  NOW,
  policyInput,
  rule,
  ruleSet,
  sampleInput,
  type InputOptions,
} from "../testing/policy-fixtures.js";
import { evaluatePolicy } from "./evaluate.js";
import { matchArgPattern } from "./patterns.js";
import { rememberRefusal } from "./remember.js";
import { rememberedRuleAllowed, rememberedRuleRefusal } from "./remember-limits.js";
import {
  endOfLocalDay,
  exactArgPattern,
  exactCanonicalInput,
  literalGlob,
  rememberExpiry,
} from "./remember-scope.js";
import { exactKeysMatch, type PolicyRule } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS } from "./settings.js";

/** KOBE-289: every remember scope and admin limit, as the engine enforces them. */

const OTHER = "99999999-9999-4999-8999-999999999999";
const kaijuWrite = builtin("share_file");
const bash = builtin("bash");
/** A sandbox write (risk write): rememberable; `bash` is destructive and never is. */
const write = builtin("write");
const jira = mcpTool("mcp__jira__create_issue", "write");

function decide(
  tool: ToolDescriptor,
  rules: readonly PolicyRule[],
  options: InputOptions & { limits?: RememberLimits; input?: JsonObject; now?: Date } = {},
): PolicyDecision {
  return evaluatePolicy({
    input: policyInput(tool, options.input ?? sampleInput(tool), options),
    tool,
    rules: ruleSet(rules, options.limits),
    connector: tool.source === "mcp" ? ENABLED_ALL : undefined,
    settings: { ...DEFAULT_POLICY_SETTINGS, promptSandboxWrites: true },
    now: options.now ?? NOW,
  });
}

const limits = (over: Partial<RememberLimits>): RememberLimits => ({
  ...DEFAULT_REMEMBER_LIMITS,
  ...over,
});

describe("thread- and run-bound rules", () => {
  it("a thread rule allows calls in its thread only", () => {
    const own = rule("user", "allow", "share_file", {
      remember_scope: "thread",
      thread_id: IDS.thread,
    });
    const other = rule("user", "allow", "share_file", {
      remember_scope: "thread",
      thread_id: OTHER,
    });
    expect(decide(kaijuWrite, [own]).effect).toBe("allow");
    expect(decide(kaijuWrite, [own]).reasons[0]).toMatchObject({
      code: "user_allow_rule",
      rule_id: own.id,
      message: "Allowed by your rule (this conversation).",
    });
    expect(decide(kaijuWrite, [other]).effect).toBe("require_approval");
  });

  it("a run rule allows calls in its run only", () => {
    const own = rule("user", "allow", "write", { remember_scope: "run", run_id: IDS.run });
    const other = rule("user", "allow", "write", { remember_scope: "run", run_id: OTHER });
    expect(decide(write, [own]).reasons[0]?.message).toBe("Allowed by your rule (this run only).");
    expect(decide(write, [other]).effect).toBe("require_approval");
  });

  it("a thread or run rule that names none never matches (fail closed)", () => {
    expect(
      decide(write, [rule("user", "allow", "write", { remember_scope: "thread" })]).effect,
    ).toBe("require_approval");
    expect(decide(write, [rule("user", "allow", "write", { remember_scope: "run" })]).effect).toBe(
      "require_approval",
    );
  });

  it("a remembered rule for a destructive tool is ignored (never rememberable)", () => {
    const r = rule("user", "allow", "bash", { remember_scope: "thread", thread_id: IDS.thread });
    expect(decide(bash, [r]).effect).toBe("require_approval");
  });

  it("an ask rule still wins over a bound rule", () => {
    const own = rule("user", "allow", "write", { remember_scope: "thread", thread_id: IDS.thread });
    const decision = decide(write, [own, rule("team", "ask", "write")]);
    expect(decision.effect).toBe("require_approval");
    expect(decision.reasons.map((r) => r.code)).toEqual(["team_ask_rule"]);
  });

  it("names each scope on the reason", () => {
    for (const [scope, label] of [
      ["today", "until end of today"],
      ["day", "for 1 day"],
      ["month", "for 30 days"],
      ["forever", "until revoked"],
    ] as const) {
      const r = rule("user", "allow", "write", { remember_scope: scope });
      expect(decide(write, [r]).reasons[0]?.message).toBe(`Allowed by your rule (${label}).`);
    }
  });
});

describe("scheduled and auto runs ignore remembered rules (D32)", () => {
  const scopes = [
    { remember_scope: "thread", thread_id: IDS.thread },
    { remember_scope: "run", run_id: IDS.run },
    { remember_scope: "today" },
    { remember_scope: "forever" },
  ] as const;
  it.each([
    [{ mode: "auto" }, "mode_auto_not_allowlisted"],
    [{ mode: "ask-on-write", kind: "schedule" }, "scheduled_run_no_prompt"],
    [{ mode: "ask-all", kind: "schedule" }, "scheduled_run_no_prompt"],
  ] as const)("%o denies (never queues) what only a remembered rule would allow", (opts, code) => {
    for (const extra of scopes) {
      const decision = decide(write, [rule("user", "allow", "write", extra)], opts);
      expect(decision.effect).toBe("deny");
      expect(decision.reasons[0]?.code).toBe(code);
    }
  });

  it("a team allow rule still allow-lists there", () => {
    const decision = decide(write, [rule("team", "allow", "write")], {
      mode: "auto",
      kind: "schedule",
    });
    expect(decision).toMatchObject({ effect: "allow", reasons: [{ code: "team_allow_rule" }] });
  });
});

describe("admin limits apply at evaluation", () => {
  const made = new Date(NOW.getTime() - 2 * 3600_000).toISOString();

  it("a scope the limits no longer allow stops applying", () => {
    const r = rule("user", "allow", "write", { remember_scope: "forever", created_at: made });
    expect(decide(write, [r], { limits: limits({ scopes: ["thread", "run"] }) }).effect).toBe(
      "require_approval",
    );
    expect(decide(write, [r], { limits: limits({ scopes: ["forever"] }) }).effect).toBe("allow");
  });

  it("the max duration counts from when the rule was made", () => {
    const r = rule("user", "allow", "write", { remember_scope: "forever", created_at: made });
    expect(decide(write, [r], { limits: limits({ max_duration_seconds: 3 * 3600 }) }).effect).toBe(
      "allow",
    );
    expect(decide(write, [r], { limits: limits({ max_duration_seconds: 3600 }) }).effect).toBe(
      "require_approval",
    );
    const undated = rule("user", "allow", "write", { remember_scope: "forever" });
    expect(
      decide(write, [undated], { limits: limits({ max_duration_seconds: 3600 }) }).effect,
    ).toBe("require_approval");
  });

  it("MCP tools may be barred from remembering", () => {
    const r = rule("user", "allow", "mcp__jira__create_issue", { remember_scope: "day" });
    const b = rule("user", "allow", "write", { remember_scope: "day" });
    const noMcp = limits({ mcp_tools: false });
    expect(decide(jira, [r], { limits: noMcp }).effect).toBe("require_approval");
    expect(decide(write, [b], { limits: noMcp }).effect).toBe("allow");
    expect(decide(jira, [r]).effect).toBe("allow");
  });

  it("exact-only keeps only rules with an argument pattern", () => {
    const loose = rule("user", "allow", "write", { remember_scope: "day" });
    const exact = rule("user", "allow", "write", {
      remember_scope: "day",
      arg_pattern: { "/path": "/workspace/notes.md" },
    });
    const only = limits({ exact_only: true });
    expect(decide(write, [loose], { limits: only }).effect).toBe("require_approval");
    expect(decide(write, [exact], { limits: only }).effect).toBe("allow");
  });

  it("rememberedRuleAllowed defaults to no limits", () => {
    expect(rememberedRuleAllowed(rule("user", "allow", "write"), write, undefined, NOW)).toBe(true);
  });
});

describe("remember choices (server-side refusal)", () => {
  it("never for destructive tools", () => {
    const fsDelete = mcpTool("mcp__fs__delete", "destructive");
    expect(rememberRefusal("day", false, { tool: fsDelete }, DEFAULT_REMEMBER_LIMITS)).toBe(
      "remember_not_allowed",
    );
  });

  it("only scopes within the limits, MCP only when allowed, exact when required", () => {
    expect(
      rememberRefusal("forever", false, { tool: write }, limits({ max_duration_seconds: 60 })),
    ).toBe("remember_not_allowed");
    expect(
      rememberRefusal("thread", false, { tool: write }, limits({ max_duration_seconds: 60 })),
    ).toBe(undefined);
    expect(rememberRefusal("day", false, { tool: jira }, limits({ mcp_tools: false }))).toBe(
      "remember_not_allowed",
    );
    expect(rememberRefusal("day", false, { tool: write }, limits({ exact_only: true }))).toBe(
      "remember_not_allowed",
    );
    expect(rememberRefusal("day", true, { tool: write }, limits({ exact_only: true }))).toBe(
      undefined,
    );
    expect(rememberRefusal("run", false, { tool: write }, limits({ scopes: ["thread"] }))).toBe(
      "remember_not_allowed",
    );
  });
});

describe("only this exact action", () => {
  it("pins bash's exact command, escaping glob characters (no pattern injection)", () => {
    const pattern = exactArgPattern(bash, { command: "rm -f *.log && echo ?\\" });
    expect(pattern).toEqual({ "/command": "rm -f \\*.log && echo \\?\\\\" });
    const p = pattern ?? {};
    expect(matchArgPattern(p, { command: "rm -f *.log && echo ?\\" }, "loosen")).toBe(true);
    expect(matchArgPattern(p, { command: "rm -f a.log && echo x\\" }, "loosen")).toBe(false);
    expect(matchArgPattern(p, { command: "rm -f *.log && echo ?\\ extra" }, "loosen")).toBe(false);
  });

  it("pins a file tool's canonical path", () => {
    const write = builtin("write");
    const pattern = exactArgPattern(write, { path: "out/../report.md", content: "x" });
    expect(pattern).toEqual({ "/path": "/workspace/report.md" });
  });

  it("pins every top-level argument of an MCP tool", () => {
    const pattern = exactArgPattern(jira, { summary: "Fix *", project: "KAIJU", labels: ["a"] });
    expect(pattern).toEqual({
      "/labels": '["a"]',
      "/project": "KAIJU",
      "/summary": "Fix \\*",
    });
  });

  it("is unavailable when no pattern fits (offered only when it does)", () => {
    expect(exactArgPattern(jira, {})).toBeUndefined();
    expect(exactArgPattern(bash, { command: "x".repeat(300) })).toBeUndefined();
    expect(exactArgPattern(builtin("read"), { path: "~/.ssh/id_rsa" })).toBeUndefined();
  });

  it("matches exactly the text after escaping", () => {
    expect(matchGlob(literalGlob("a*b?c\\d"), "a*b?c\\d")).toBe(true);
    expect(matchGlob(literalGlob("a*b"), "aXXb")).toBe(false);
  });
});

describe("only this exact action matches on canonical JSON (KOBE-783, P2-23)", () => {
  /** A user rule as `insertUserAllowRule` stores "only this exact action" of `input`. */
  const exactRule = (input: JsonObject) => {
    const pattern = exactArgPattern(jira, input);
    const canonical = exactCanonicalInput(jira, input);
    if (pattern === undefined || canonical === undefined) throw new Error("no exact pattern");
    return rule("user", "allow", jira.name, {
      remember_scope: "forever",
      arg_pattern: pattern,
      exact_keys: true,
      exact_input: canonical,
    });
  };
  const outcome = (r: PolicyRule, input: JsonObject) => decide(jira, [r], { input }).effect;

  it("a number never matches its string, nor an object or a list its JSON text", () => {
    const n = exactRule({ project: "KAIJU", limit: 5 });
    expect(outcome(n, { project: "KAIJU", limit: 5 })).toBe("allow");
    expect(outcome(n, { project: "KAIJU", limit: "5" })).toBe("require_approval");
    const s = exactRule({ project: "KAIJU", limit: "5" });
    expect(outcome(s, { project: "KAIJU", limit: "5" })).toBe("allow");
    expect(outcome(s, { project: "KAIJU", limit: 5 })).toBe("require_approval");
    const o = exactRule({ project: "KAIJU", fields: { a: 1 }, labels: ["x"] });
    expect(outcome(o, { project: "KAIJU", fields: '{"a":1}', labels: ["x"] })).toBe(
      "require_approval",
    );
    expect(outcome(o, { project: "KAIJU", fields: { a: 1 }, labels: '["x"]' })).toBe(
      "require_approval",
    );
    const b = exactRule({ project: "KAIJU", draft: true });
    expect(outcome(b, { project: "KAIJU", draft: "true" })).toBe("require_approval");
  });

  it("key order and number spelling neither defeat nor widen it (the approval's canonical form)", () => {
    const r = exactRule({ project: "KAIJU", fields: { b: 2, a: 1 }, priority: 2 });
    const same = JSON.parse(
      '{"priority":2.0,"fields":{"a":1,"b":2},"project":"KAIJU"}',
    ) as JsonObject;
    expect(outcome(r, same)).toBe("allow");
    expect(outcome(r, { project: "KAIJU", fields: { a: 1, b: 2 }, priority: 3 })).toBe(
      "require_approval",
    );
    expect(outcome(r, { project: "KAIJU", fields: { a: 1, b: 2, c: 3 }, priority: 2 })).toBe(
      "require_approval",
    );
  });

  it("a rule stored before the canonical form keeps only what its text says unambiguously", () => {
    // Its glob text can't tell `5` from "5", nor an object from its JSON text: those never match
    // (the member is asked again); plain text still matches a string, and nothing else.
    const legacy = rule("user", "allow", jira.name, {
      remember_scope: "forever",
      arg_pattern: { "/project": "KAIJU", "/limit": "5" },
      exact_keys: true,
    });
    expect(outcome(legacy, { project: "KAIJU", limit: 5 })).toBe("require_approval");
    expect(outcome(legacy, { project: "KAIJU", limit: "5" })).toBe("require_approval");
    const text = rule("user", "allow", jira.name, {
      remember_scope: "forever",
      arg_pattern: { "/project": "KAIJU", "/summary": "Fix it" },
      exact_keys: true,
    });
    expect(outcome(text, { project: "KAIJU", summary: "Fix it" })).toBe("allow");
    expect(outcome(text, { project: ["KAIJU"], summary: "Fix it" })).toBe("require_approval");
  });
});

describe("server-computed expiries", () => {
  it("until end of today ends at the member's midnight", () => {
    // 12:00 UTC = 14:00 in Berlin (CEST) → midnight Berlin = 22:00 UTC.
    expect(rememberExpiry("today", NOW, "Europe/Berlin", null)?.toISOString()).toBe(
      "2026-10-02T22:00:00.000Z",
    );
    // 12:00 UTC = 08:00 in New York (EDT) → midnight New York = 04:00 UTC next day.
    expect(rememberExpiry("today", NOW, "America/New_York", null)?.toISOString()).toBe(
      "2026-10-03T04:00:00.000Z",
    );
    // No stored zone, or an unusable one: UTC.
    expect(rememberExpiry("today", NOW, null, null)?.toISOString()).toBe(
      "2026-10-03T00:00:00.000Z",
    );
    expect(rememberExpiry("today", NOW, "Mars/Base", null)?.toISOString()).toBe(
      "2026-10-03T00:00:00.000Z",
    );
  });

  it("handles a day that is 25 hours long (DST ends)", () => {
    // 2026-10-25: Europe/Berlin goes back from CEST to CET; midnight after is 23:00 UTC.
    const morning = new Date("2026-10-25T06:00:00Z");
    expect(endOfLocalDay("Europe/Berlin", morning).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("fixed lifetimes, none for thread/run/forever, all capped by the max duration", () => {
    expect(rememberExpiry("day", NOW, null, null)?.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(rememberExpiry("month", NOW, null, null)?.toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    for (const scope of ["thread", "run", "forever"] as const) {
      expect(rememberExpiry(scope, NOW, null, null)).toBeNull();
      expect(rememberExpiry(scope, NOW, null, 600)?.toISOString()).toBe("2026-10-02T12:10:00.000Z");
    }
    expect(rememberExpiry("today", NOW, "Europe/Berlin", 3600)?.toISOString()).toBe(
      "2026-10-02T13:00:00.000Z",
    );
  });
});

describe("review S3/S4: exact means exact", () => {
  const pattern = { "/project": "KAIJU", "/summary": "Fix" };
  const exact = rule("user", "allow", "mcp__jira__create_issue", {
    remember_scope: "forever",
    arg_pattern: pattern,
    exact_keys: true,
  });

  it("an exact MCP rule matches the same arguments only: no extra, none missing", () => {
    expect(decide(jira, [exact], { input: { project: "KAIJU", summary: "Fix" } }).effect).toBe(
      "allow",
    );
    expect(
      decide(jira, [exact], { input: { project: "KAIJU", summary: "Fix", body: "leak" } }).effect,
    ).toBe("require_approval");
    expect(decide(jira, [exact], { input: { project: "KAIJU" } }).effect).toBe("require_approval");
    // Without the key check (older rules) only the pinned pointers count.
    const loose = { ...exact, exact_keys: false };
    expect(
      decide(jira, [loose], { input: { project: "KAIJU", summary: "Fix", body: "x" } }).effect,
    ).toBe("allow");
  });

  it("decodes escaped keys and refuses deeper pointers", () => {
    expect(exactKeysMatch({ "/a~1b": "x", "/c~0": "y" }, { "a/b": "x", "c~": "y" })).toBe(true);
    expect(exactKeysMatch({ "/a/b": "x" }, { a: { b: "x" } })).toBe(false);
    expect(exactKeysMatch(undefined, {})).toBe(false);
  });

  it("under exact-only, an older wildcard pattern is not exact and is ignored", () => {
    const only = limits({ exact_only: true });
    const wildcard = rule("user", "allow", "write", {
      remember_scope: "forever",
      arg_pattern: { "/path": "/workspace/*" },
    });
    const literal = rule("user", "allow", "write", {
      remember_scope: "forever",
      arg_pattern: { "/path": "/workspace/notes.md" },
    });
    expect(decide(write, [wildcard], { limits: only }).effect).toBe("require_approval");
    expect(decide(write, [literal], { limits: only }).effect).toBe("allow");
    expect(rememberedRuleRefusal(wildcard, write, only, NOW)).toBe("not_exact");
  });

  it("under exact-only, an older literal MCP rule without the key set is not exact (review R2)", () => {
    const only = limits({ exact_only: true });
    const old = rule("user", "allow", "mcp__jira__create_issue", {
      remember_scope: "forever",
      arg_pattern: pattern,
    });
    const extra = { project: "KAIJU", summary: "Fix", body: "leak" };
    expect(decide(jira, [old], { limits: only, input: extra }).effect).toBe("require_approval");
    expect(
      decide(jira, [old], { limits: only, input: { project: "KAIJU", summary: "Fix" } }).effect,
    ).toBe("require_approval");
    expect(rememberedRuleRefusal(old, jira, only, NOW)).toBe("not_exact");
    // The same rule made by KOBE-289 (key set pinned) counts, and still refuses extra arguments.
    expect(
      decide(jira, [exact], { limits: only, input: { project: "KAIJU", summary: "Fix" } }).effect,
    ).toBe("allow");
    expect(decide(jira, [exact], { limits: only, input: extra }).effect).toBe("require_approval");
  });

  it("names why a rule no longer applies", () => {
    const r = rule("user", "allow", "bash", {
      remember_scope: "forever",
      created_at: NOW.toISOString(),
    });
    expect(rememberedRuleRefusal(r, bash, undefined, NOW)).toBe("destructive");
    expect(
      rememberedRuleRefusal({ ...r, tool_glob: "write" }, write, limits({ scopes: ["run"] }), NOW),
    ).toBe("scope_not_allowed");
    expect(
      rememberedRuleRefusal(
        { ...r, created_at: "2026-01-01T00:00:00.000Z" },
        write,
        limits({ max_duration_seconds: 60 }),
        NOW,
      ),
    ).toBe("too_old");
  });
});
