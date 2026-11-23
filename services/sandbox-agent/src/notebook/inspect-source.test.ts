import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  NOTEBOOK_REPR_MAX_CHARS,
  NOTEBOOK_VARIABLES_MAX,
  notebookOtherNameSchema,
  notebookVariableSchema,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";

/**
 * The kernel bridge's variables snapshot (KOBE-803; KOBE-816: STATIC_SOURCE's `variables`, what
 * the kernel's inspect handler answers, images/sandbox/kernel/kobe-kernel-bridge.py) on plain
 * Python (testing/inspect-harness.py): what is left out, the caps, and that no code of the
 * member's runs: values only of exact built-ins (subclasses through the built-in's methods),
 * numpy and pandas; anything else is `not_read`, its repr/str/len/iter never called. The real
 * kernel and transport (inspection request: no hooks, no execution count) are checked by
 * images/sandbox/test-image.sh and transport.e2e.test.ts.
 */
const BRIDGE = fileURLToPath(
  new URL("../../../../images/sandbox/kernel/kobe-kernel-bridge.py", import.meta.url),
);
const HARNESS = fileURLToPath(new URL("./testing/inspect-harness.py", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

interface Snap {
  readonly variables: Record<string, unknown>[];
  readonly other: Record<string, unknown>[];
  readonly truncated: boolean;
  readonly elapsed_ms: number;
  readonly user_names_after: string[];
}

function snap(scenario: string): Snap {
  const res = spawnSync("python3", ["-I", HARNESS, BRIDGE, scenario], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`harness failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as Snap;
}

const byName = (s: Snap) => new Map(s.variables.map((v) => [v.name as string, v]));

describe.skipIf(!hasPython)("kernel variables snapshot (KOBE-803)", () => {
  it("lists user variables with summaries; leaves out _names and IPython's; names the rest", () => {
    const s = snap("basic");
    expect(s.variables.map((v) => v.name)).toEqual(["d", "n", "s", "xs"]);
    const v = byName(s);
    expect(v.get("n")).toEqual({ name: "n", type: "int", repr: "42" });
    expect(v.get("xs")).toMatchObject({ type: "list", len: 1000 });
    expect((v.get("xs")?.repr as string).length).toBeLessThan(60);
    expect(s.other).toEqual([
      { name: "Raises", kind: "class" },
      { name: "f", kind: "function" },
      { name: "length", kind: "function" },
      { name: "math", kind: "module" },
    ]);
    expect(s.truncated).toBe(false);
    for (const item of s.variables)
      expect(notebookVariableSchema.safeParse(item).success).toBe(true);
    for (const item of s.other) expect(notebookOtherNameSchema.safeParse(item).success).toBe(true);
    // Nothing was added to the user's namespace.
    expect(s.user_names_after).not.toContain("snapshot");
    expect(s.user_names_after).not.toContain("Snapshot");
  });

  it("a member's object is never read: type only, no repr, however hostile (KOBE-816)", () => {
    const s = snap("hostile");
    const v = byName(s);
    for (const name of ["bad", "quits", "slow", "sleepy", "huge"]) {
      expect(v.get(name), name).toMatchObject({
        repr: "",
        repr_error: "not_read",
        module: "__main__",
      });
    }
    expect(v.get("ok")).toMatchObject({ repr: "1" });
    expect(s.elapsed_ms).toBeLessThan(500);
    for (const item of s.variables)
      expect(notebookVariableSchema.safeParse(item).success).toBe(true);
  });

  it("records zero calls into member code: repr, str, len, iter, __class__, __getattribute__, metaclass, hashing keys; the lock is never taken", () => {
    const s = snap("recording") as Snap & { ran: string[]; lock_locked: boolean };
    expect(s.ran).toEqual([]);
    expect(s.lock_locked).toBe(false);
    const v = byName(s);
    for (const name of ["rec", "cp", "ga", "wm", "lock"]) {
      expect(v.get(name), name).toMatchObject({ repr: "", repr_error: "not_read" });
    }
    // Subclasses of built-in containers: the built-in's own length and items, not the subclass's.
    expect(v.get("hl")).toMatchObject({ type: "HookList", len: 3, repr: "[1, 2, 3]" });
    expect(v.get("hd")).toMatchObject({ type: "HookDict", len: 1, repr: "{'a': <Recorder>}" });
    // Inside built-in containers a member's object is its type name only.
    expect(v.get("nested")?.repr).toBe("[<Recorder>, {'k': <LockRepr>}, (<ClassProperty>, 1)]");
    expect(v.get("keyed")?.repr).toBe("{<Key>: 1, 'plain': <Recorder>}");
  });

  it("huge values are bounded: a few items, capped text, a summarised int", () => {
    const s = snap("huge");
    const v = byName(s);
    expect(v.get("big_list")).toMatchObject({
      len: 5_000_000,
      repr: "[0, 1, 2, 3, 4, 5, 6, 7, ...]",
    });
    expect(v.get("big_dict")).toMatchObject({ len: 2_000_000 });
    expect(v.get("big_set")).toMatchObject({ len: 1_000_000 });
    expect((v.get("big_str")?.repr as string).length).toBe(NOTEBOOK_REPR_MAX_CHARS);
    expect(v.get("big_int")?.repr).toBe("<int of about 100000 digits>");
    expect(v.get("deep")?.repr).toBe("[[[...]]]");
    expect(s.elapsed_ms).toBeLessThan(500);
  });

  it("summarizes numpy arrays and pandas frames and series without their data", () => {
    const v = byName(snap("data"));
    expect(v.get("arr")).toMatchObject({ module: "numpy", shape: [3, 4], dtype: "float64" });
    expect(v.get("df")).toMatchObject({
      module: "pandas",
      shape: [3, 2],
      columns_total: 2,
      columns: [
        { name: "a", dtype: "int64" },
        { name: "b", dtype: "object" },
      ],
      repr: "DataFrame: 3 rows × 2 columns",
    });
    expect(v.get("ser")).toMatchObject({ module: "pandas", len: 2, shape: [2], dtype: "int64" });
    expect(v.get("wide")).toMatchObject({ shape: [1, 80], columns_total: 80 });
    expect(v.get("wide")?.columns as unknown[]).toHaveLength(50);
    for (const item of v.values())
      expect(notebookVariableSchema.safeParse(item).success).toBe(true);
  });

  it("subclasses of built-in containers and strings: the built-in's own length and items, never theirs", () => {
    const v = byName(snap("subclasses"));
    expect(v.get("big")).toEqual({
      name: "big",
      type: "BigList",
      module: "__main__",
      len: 1_000_000,
      repr: "[0, 1, 2, 3, 4, 5, 6, 7, ...]",
    });
    expect(v.get("text")).toMatchObject({ type: "Text", len: 10_000 });
    expect((v.get("text")?.repr as string).length).toBe(NOTEBOOK_REPR_MAX_CHARS);
    expect(v.get("text")).not.toHaveProperty("repr_error");
  });

  it("caps the count, and the kernel-side budget, with truncated", () => {
    const many = snap("many");
    expect(many.variables).toHaveLength(NOTEBOOK_VARIABLES_MAX);
    expect(many.truncated).toBe(true);
    // A spent time budget stops between variables, marked truncated.
    const budget = snap("budget");
    expect(budget.truncated).toBe(true);
    expect(budget.variables.length).toBeLessThan(5);
  });
});
