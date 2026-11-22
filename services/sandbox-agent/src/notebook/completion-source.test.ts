import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NOTEBOOK_COMPLETE_MATCHES_MAX, notebookCompletionResultSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";

/**
 * The kernel bridge's completion helpers (KOBE-808, images/sandbox/kernel/kobe-kernel-bridge.py)
 * on plain Python (testing/completion-harness.py): `doc` resolves names without running any of the
 * member's code (no property getter, `__getattr__`, repr or call), and `completion_result` caps
 * and cleans a `complete_reply`. The real kernel (jedi off, limited evaluation, silent requests)
 * is checked by images/sandbox/test-image.sh.
 */
const BRIDGE = fileURLToPath(
  new URL("../../../../images/sandbox/kernel/kobe-kernel-bridge.py", import.meta.url),
);
const HARNESS = fileURLToPath(new URL("./testing/completion-harness.py", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function harness(scenario: string): Record<string, unknown> | null {
  const res = spawnSync("python3", ["-I", HARNESS, BRIDGE, scenario], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as Record<string, unknown> | null;
}

describe.skipIf(!hasPython)("kernel documentation lookup (KOBE-808)", () => {
  it("a method through an instance: its signature without self, its docstring; nothing runs", () => {
    const d = harness("doc:h.method");
    expect(d).toMatchObject({
      found: true,
      signature: "method(x, y=2)",
      doc: "Doc of method.",
      type: "function",
      ran: [],
    });
  });

  it("a property: the getter's docstring, the getter never runs", () => {
    expect(harness("doc:h.prop")).toMatchObject({ found: true, doc: "The prop.", ran: [] });
    expect(harness("doc:h.prop")).not.toHaveProperty("signature");
  });

  it("a missing attribute: not found, and __getattr__ never runs", () => {
    expect(harness("doc:h.nothing")).toMatchObject({ found: false, ran: [] });
  });

  it("an instance: its type's docstring, never its repr; no signature for a callable instance", () => {
    const d = harness("doc:h");
    expect(d).toMatchObject({ found: true, type: "Hostile", doc: "A Hostile object.", ran: [] });
    expect(d).not.toHaveProperty("signature");
    // object's own docstring is never shown for a class without one.
    expect(harness("doc:p")).toEqual(
      expect.objectContaining({ found: true, type: "Plain", ran: [] }),
    );
    expect(harness("doc:p")).not.toHaveProperty("doc");
  });

  it("functions, classes, static methods, modules and builtins", () => {
    expect(harness("doc:add")).toMatchObject({ signature: "add(a, b=1)", doc: "Adds." });
    expect(harness("doc:Hostile")).toMatchObject({ signature: "Hostile()", type: "type" });
    expect(harness("doc:Hostile.static")).toMatchObject({
      signature: "static(a)",
      doc: "Doc of static.",
    });
    expect(harness("doc:json.dumps")).toMatchObject({ found: true, type: "function" });
    expect(harness("doc:json")).toMatchObject({ found: true, type: "module" });
    expect(harness("doc:len")).toMatchObject({ found: true, signature: "len(obj, /)" });
    expect(harness("doc:nope")).toMatchObject({ found: false });
  });
});

describe.skipIf(!hasPython)("kernel completion answers (KOBE-808)", () => {
  const valid = (r: unknown) =>
    expect(notebookCompletionResultSchema.safeParse(r).success).toBe(true);

  it("attribute matches start after the dot, deduplicated, with the kernel's types", () => {
    const r = harness("complete-dot");
    expect(r).toEqual({
      status: "ok",
      op: "complete",
      matches: [{ text: "align", type: "attribute" }, { text: "all" }, { text: "alpha" }],
      cursor_start: 3,
      cursor_end: 5,
    });
    valid(r);
  });

  it("caps the count and drops overlong or NUL matches", () => {
    const r = harness("complete-many") as { matches: { text: string }[] };
    expect(r.matches).toHaveLength(NOTEBOOK_COMPLETE_MATCHES_MAX);
    expect(r.matches.some((m) => m.text.startsWith("y") || m.text.includes("\u0000"))).toBe(false);
    valid(r);
  });

  it("an error reply is no answer; a cursor span outside the code falls back to the cursor", () => {
    expect(harness("complete-error")).toBeNull();
    expect(harness("complete-bad-cursor")).toMatchObject({ cursor_start: 2, cursor_end: 2 });
  });
});
