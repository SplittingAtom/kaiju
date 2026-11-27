import { describe, expect, it } from "vitest";
import type { PolicyDecision } from "@kaiju/protocol";
import { builtin, rule } from "../testing/policy-fixtures.js";
import { run } from "./evaluate.test-helpers.js";
import {
  EDITOR_FILE_REASON,
  editorToolTarget,
  guardEditorFile,
  type EditorFileGuard,
} from "./editor-file-guard.js";

/** KOBE-848: running the open script is a write that asks; reading its run pane is a read. */
const editorRun = builtin("editor_run");
const editorRead = builtin("editor_read");
const RUN_INPUT = { path: "/workspace/analysis.py" };
const READ_INPUT = { path: "analysis.py", what: "variables" };

describe("editor tools in the policy engine (KOBE-848)", () => {
  it("editor_run asks in ask-on-write (the default) and in ask-all", () => {
    for (const mode of ["ask-on-write", "ask-all"] as const) {
      const decision = run({ tool: editorRun, input: RUN_INPUT, options: { mode } });
      expect(decision.effect, mode).toBe("require_approval");
    }
    expect(run({ tool: editorRun, input: RUN_INPUT }).reasons[0]).toMatchObject({
      code: "risk_write",
      stage: "risk_class",
    });
  });

  it("editor_read never asks in ask-on-write, and runs in auto mode and scheduled runs", () => {
    expect(run({ tool: editorRead, input: READ_INPUT }).effect).toBe("allow");
    expect(run({ tool: editorRead, input: READ_INPUT, options: { mode: "auto" } }).effect).toBe(
      "allow",
    );
    expect(run({ tool: editorRead, input: READ_INPUT, options: { kind: "schedule" } }).effect).toBe(
      "allow",
    );
  });

  it("the member's remembered approval lifts editor_run's prompt", () => {
    const decision = run({
      tool: editorRun,
      input: RUN_INPUT,
      rules: [rule("user", "allow", "editor_run")],
    });
    expect(decision.effect).toBe("allow");
    expect(decision.reasons[0]?.code).toBe("user_allow_rule");
  });

  it("auto mode and scheduled runs deny editor_run unless a team allow rule lists it", () => {
    for (const options of [{ mode: "auto" as const }, { kind: "schedule" as const }]) {
      expect(run({ tool: editorRun, input: RUN_INPUT, options }).effect).toBe("deny");
      const listed = run({
        tool: editorRun,
        input: RUN_INPUT,
        options,
        rules: [rule("team", "allow", "editor_run")],
      });
      expect(listed.effect).toBe("allow");
    }
  });

  it("Dangerous mode never lifts editor_run's prompt (a Kaiju-scoped write)", () => {
    const decision = run({
      tool: editorRun,
      input: RUN_INPUT,
      options: { dangerous: ["editor_run"] },
    });
    expect(decision.effect).toBe("require_approval");
  });

  it("deny rules and the agent's tools.deny still refuse both", () => {
    expect(
      run({ tool: editorRun, input: RUN_INPUT, rules: [rule("team", "deny", "editor_*")] }).effect,
    ).toBe("deny");
    expect(
      run({ tool: editorRead, input: READ_INPUT, options: { toolsDeny: ["editor_read"] } }).effect,
    ).toBe("deny");
  });

  it("refuses input that is not a .py path (strict schema)", () => {
    for (const input of [{ path: "a.ipynb" }, { path: "a.py", code: "x" }, { code: "x" }]) {
      expect(run({ tool: editorRun, input }).reasons[0]?.code).toBe("invalid_input");
    }
    expect(run({ tool: editorRead, input: { path: "a.py", what: "all" } }).effect).toBe("deny");
  });
});

const ALLOW: PolicyDecision = {
  effect: "allow",
  risk: "read",
  reasons: [{ code: "risk_read", stage: "risk_class", message: "reads" }],
};
const ASK: PolicyDecision = {
  effect: "require_approval",
  risk: "write",
  reasons: [{ code: "risk_write", stage: "risk_class", message: "writes" }],
  expires_at: "2026-11-26T10:00:00.000Z",
};

function guard(over: Partial<EditorFileGuard> = {}): EditorFileGuard {
  return { tool: editorRun, input: RUN_INPUT, viewedPath: "analysis.py", ...over };
}

describe("the editor-file guard (KOBE-848)", () => {
  it.each([
    ["analysis.py", "analysis.py"],
    ["/workspace/analysis.py", "analysis.py"],
    ["./src/../analysis.py", "analysis.py"],
    ["/etc/passwd.py", undefined],
  ])("normalises %s", (raw, expected) => {
    expect(editorToolTarget({ path: raw })).toBe(expected);
  });

  it("passes a call on the viewed .py file unchanged, whatever the decision", () => {
    expect(guardEditorFile(ASK, guard())).toBe(ASK);
    expect(guardEditorFile(ALLOW, guard({ tool: editorRead, input: READ_INPUT }))).toBe(ALLOW);
  });

  it("denies another file, a non-.py viewed file and a run without one, in every mode", () => {
    const cases: Partial<EditorFileGuard>[] = [
      { input: { path: "other.py" } },
      { viewedPath: "notes.md", input: { path: "notes.md" } },
      { viewedPath: undefined },
      { tool: editorRead, input: { path: "other.py", what: "output" } },
    ];
    for (const over of cases) {
      for (const decision of [ALLOW, ASK]) {
        const out = guardEditorFile(decision, guard(over));
        expect(out.effect).toBe("deny");
        expect(out.reasons).toEqual([
          expect.objectContaining({ code: EDITOR_FILE_REASON, stage: "site_deny" }),
        ]);
      }
    }
    const named = guardEditorFile(ASK, guard({ input: { path: "other.py" } }));
    expect(named.reasons[0]?.message).toContain("/workspace/analysis.py");
  });

  it("leaves other tools and an engine deny alone", () => {
    const deny: PolicyDecision = { effect: "deny", risk: "write", reasons: [] };
    expect(guardEditorFile(deny, guard({ viewedPath: undefined }))).toBe(deny);
    const runPython = guard({ tool: builtin("run_python"), input: { path: "other.py" } });
    expect(guardEditorFile(ASK, runPython)).toBe(ASK);
  });
});
