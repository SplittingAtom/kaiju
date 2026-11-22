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
 * The kernel bridge's variables snapshot (KOBE-803, images/sandbox/kernel/kobe-kernel-bridge.py)
 * run on plain Python through its own user expression (testing/inspect-harness.py): what is left
 * out, the caps, and that a hostile `__repr__` (raising, looping, sleeping, exiting, huge) costs
 * only that variable's repr. The real kernel (silent request, no execution count) is checked by
 * images/sandbox/test-image.sh.
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

  it("a repr that raises, loops, sleeps, exits or is huge never breaks the snapshot", () => {
    const s = snap("hostile");
    const v = byName(s);
    expect(v.get("bad")).toMatchObject({ repr: "", repr_error: "raised", module: "__main__" });
    expect(v.get("quits")).toMatchObject({ repr: "", repr_error: "raised" });
    expect(v.get("slow")).toMatchObject({ repr: "", repr_error: "timeout" });
    expect(v.get("sleepy")).toMatchObject({ repr: "", repr_error: "timeout" });
    expect((v.get("huge")?.repr as string).length).toBe(NOTEBOOK_REPR_MAX_CHARS);
    expect(v.get("ok")).toMatchObject({ repr: "1" });
    // Two timed-out reprs at 200 ms each, not their 30 s or forever.
    expect(s.elapsed_ms).toBeLessThan(3_000);
    for (const item of s.variables)
      expect(notebookVariableSchema.safeParse(item).success).toBe(true);
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

  it("caps the count, and the kernel-side budget, with truncated", () => {
    const many = snap("many");
    expect(many.variables).toHaveLength(NOTEBOOK_VARIABLES_MAX);
    expect(many.truncated).toBe(true);
    const budget = snap("budget");
    expect(budget.truncated).toBe(true);
    expect(budget.variables.length).toBeLessThan(5);
    expect(budget.elapsed_ms).toBeLessThan(2_000);
  });
});
