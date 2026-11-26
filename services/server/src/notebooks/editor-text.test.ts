import { describe, expect, it } from "vitest";
import {
  EDITOR_LOG_MAX_ENTRIES,
  EDITOR_PREVIEW_MAX_CHARS,
  EDITOR_READ_TEXT_MAX_BYTES,
  EDITOR_VARIABLES_MAX,
  type NotebookHistoryEntry,
  type NotebookVariable,
} from "@kaiju/protocol";
import { logText, outputText, preview, runLine, variablesText } from "./editor-text.js";

const RUN = "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const exec = (n: number) => `6b3c4d5e-7f8a-4b9c-8d1e-2f3a4b5c6d${String(n).padStart(2, "0")}`;

function entry(n: number, over: Partial<NotebookHistoryEntry> = {}): NotebookHistoryEntry {
  return {
    run_id: RUN,
    run_ended: true,
    started_at: `2026-11-26T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    started: { exec_id: exec(n), origin: "user", path: "analysis.py" },
    finished: {
      exec_id: exec(n),
      status: "ok",
      execution_count: n,
      outputs: 1,
      truncated: false,
      saved: null,
      timing: {
        started_at: "2026-11-26T10:00:00.000Z",
        finished_at: "2026-11-26T10:00:01.000Z",
        duration_ms: 1200,
      },
    },
    ...over,
  };
}

describe("editor_read texts (KOBE-848)", () => {
  it("one run per line: who, how it ended, how long, its error at the file's line", () => {
    expect(runLine(entry(1))).toBe("2026-11-26T10:00:01.000Z · by user · done · 1.2 s · [1]");
    const failed = entry(2, {
      started: {
        exec_id: exec(2),
        origin: "agent",
        tool_call_id: "t",
        path: "a.py",
        lines: { start: 10, end: 12 },
      },
      finished: {
        exec_id: exec(2),
        status: "error",
        execution_count: 2,
        outputs: 1,
        truncated: true,
        saved: null,
        error: { name: "ZeroDivisionError", line: 2 },
      },
    });
    expect(runLine(failed)).toBe(
      "2026-11-26T10:00:02.000Z · by agent · error · [2] · lines 10-12 · ZeroDivisionError at line 11 · output cut",
    );
    expect(runLine(entry(3, { finished: null, run_ended: false }))).toContain("running");
  });

  it("output: the newest run's header and its printed text, bounded", () => {
    const outputs = [{ output_type: "stream" as const, name: "stdout" as const, text: "42\n" }];
    const out = outputText("analysis.py", entry(1), outputs);
    expect(out.text).toBe(`Newest run of analysis.py: ${runLine(entry(1))}\n\n42\n`);
    expect(out.truncated).toBe(false);
    const big = [
      { output_type: "stream" as const, name: "stdout" as const, text: "x".repeat(1e5) },
    ];
    const cut = outputText("analysis.py", entry(1), big);
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(EDITOR_READ_TEXT_MAX_BYTES);
    expect(cut.text).toContain("bytes cut");
    expect(outputText("a.py", undefined, []).text).toBe(
      "a.py has not been run in this conversation yet.",
    );
  });

  it("log: at most the newest runs, then a count", () => {
    const many = Array.from({ length: EDITOR_LOG_MAX_ENTRIES + 1 }, (_, i) => entry(i + 1));
    const log = logText("analysis.py", many);
    expect(log.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(
      EDITOR_LOG_MAX_ENTRIES,
    );
    expect(log.text).toContain("(1 older not shown)");
  });

  it("variables: names, types, summaries and short previews; hidden names stay hidden", () => {
    const vars: NotebookVariable[] = [
      {
        name: "df",
        type: "DataFrame",
        module: "pandas",
        repr: "",
        shape: [3, 2],
        columns_total: 2,
      },
      { name: "n", type: "int", repr: "42" },
      { name: "s", type: "str", repr: `'${"a".repeat(300)}'`, len: 300 },
      { name: "api_token", type: "str", repr: "", hidden: "name", len: 40 },
      { name: "obj", type: "Thing", module: "__main__", repr: "", repr_error: "not_read" },
    ];
    const out = variablesText({
      status: "ok",
      taken_at: "2026-11-26T10:00:00.000Z",
      execution_count: 4,
      variables: vars,
      other: [{ name: "np", kind: "module" }],
      truncated: false,
    });
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("Variables in the kernel (execution count 4):");
    expect(lines).toContain("- df: pandas.DataFrame (shape [3,2], 2 columns)");
    expect(lines).toContain("- n: int = 42");
    expect(lines).toContain("- api_token: str (len 40) = (value hidden: credential-like name)");
    expect(lines).toContain("- obj: __main__.Thing (value not shown)");
    const s = lines.find((l) => l.startsWith("- s:")) ?? "";
    expect([...s.slice(s.indexOf("= ") + 2)]).toHaveLength(EDITOR_PREVIEW_MAX_CHARS);
    expect(out.text).toContain("Also defined (names only): np (module)");
    expect(out.truncated).toBe(false);
  });

  it("variables: capped in count, and plain lines when there is no snapshot", () => {
    const vars = Array.from({ length: EDITOR_VARIABLES_MAX + 5 }, (_, i) => ({
      name: `v${i}`,
      type: "int",
      repr: String(i),
    }));
    const out = variablesText({
      status: "ok",
      taken_at: "2026-11-26T10:00:00.000Z",
      execution_count: null,
      variables: vars,
      other: [],
      truncated: false,
      stale: true,
    });
    expect(out.text).toContain("(5 more not shown)");
    expect(out.text).toContain("before the latest code ran");
    expect(out.truncated).toBe(true);
    expect(variablesText({ status: "no_kernel" }).text).toContain("not running");
    expect(variablesText({ status: "busy" }).text).toContain("Code is running");
  });

  it("previews are one line", () => {
    expect(preview("a\n  b\tc")).toBe("a b c");
  });
});
