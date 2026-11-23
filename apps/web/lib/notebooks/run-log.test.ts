import { describe, expect, it } from "vitest";
import type { Execution } from "./executions";
import {
  errorLine,
  failed,
  formatClock,
  formatDuration,
  startedAt,
  statusWord,
  whoRan,
} from "./run-log";

const exec = (extra: Partial<Execution> = {}): Execution => ({
  threadId: "t",
  runId: "r",
  execId: "e",
  origin: "user",
  outputs: [],
  ...extra,
});
const end = (status: "ok" | "error", more: object = {}) => ({
  status,
  executionCount: 1,
  truncated: false,
  saved: null,
  ...more,
});

describe("run log words (KOBE-804)", () => {
  it("formats durations and a running clock", () => {
    expect(formatDuration(350)).toBe("350 ms");
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(125_000)).toBe("2:05");
    expect(formatDuration(-1)).toBe("");
    expect(formatClock(7_400)).toBe("0:07");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("says how it ended and who ran it", () => {
    expect(statusWord(exec())).toBe("Running");
    expect(statusWord(exec({ finished: end("ok") }))).toBe("Done");
    expect(statusWord(exec({ finished: end("error") }))).toBe("Error");
    expect(failed(exec({ finished: end("error") }))).toBe(true);
    expect(failed(exec({ finished: end("ok") }))).toBe(false);
    expect(failed(exec())).toBe(false);
    expect(whoRan(exec({ origin: "agent" }))).toBe("Agent");
    expect(whoRan(exec())).toBe("You");
  });

  it("puts a selection's error line back in the file", () => {
    const error = { error: { name: "KeyError", line: 2 } };
    expect(errorLine(exec({ finished: end("error", error) }))).toBe(2);
    expect(errorLine(exec({ finished: end("error", error), lines: { start: 10, end: 12 } }))).toBe(
      11,
    );
    expect(errorLine(exec({ finished: end("error", { error: { name: "X" } }) }))).toBeUndefined();
  });

  it("prefers the sandbox's start time", () => {
    const timing = { startedAt: "2026-11-22T10:00:01Z", finishedAt: "x", durationMs: 1 };
    expect(startedAt(exec({ startedAt: "2026-11-22T10:00:00Z" }))).toBe(
      Date.parse("2026-11-22T10:00:00Z"),
    );
    expect(startedAt(exec({ finished: end("ok", { timing }) }))).toBe(
      Date.parse("2026-11-22T10:00:01Z"),
    );
    expect(startedAt(exec())).toBeUndefined();
  });
});
