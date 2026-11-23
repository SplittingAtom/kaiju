/**
 * The run log's words (KOBE-804 Log tab, KOBE-805 run clock): how long a run took, how it ended,
 * who ran it, and where its error is in the file.
 */
import type { Execution } from "./executions";

/** "350 ms", "4.2 s", "2:05" (minutes), "1:02:05" (hours). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatClock(ms);
}

/** A running clock: "0:07", "12:30", "1:02:05". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  ok: "Done",
  error: "Error",
  interrupted: "Stopped",
  timeout: "Timed out",
  restarted: "Kernel restarted",
  failed: "Could not run",
};

/** How it ended in a word or two; "Running" while it runs. */
export function statusWord(exec: Execution): string {
  const end = exec.finished;
  return end === undefined ? "Running" : (STATUS_WORDS[end.status] ?? end.status);
}

/** Whether it ended badly (the Log tab's badge, and its error styling). */
export function failed(exec: Execution): boolean {
  const status = exec.finished?.status;
  return status !== undefined && status !== "ok";
}

export const whoRan = (exec: Execution): string => (exec.origin === "agent" ? "Agent" : "You");

/** The error's line in the file: a selection's line counts from where the selection began. */
export function errorLine(exec: Execution): number | undefined {
  const line = exec.finished?.error?.line;
  if (line === undefined) return undefined;
  return exec.lines === undefined ? line : line + exec.lines.start - 1;
}

/** When it started (the sandbox's clock when known), as an instant, or undefined. */
export function startedAt(exec: Execution): number | undefined {
  const iso = exec.finished?.timing?.startedAt ?? exec.startedAt;
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** How long it has been running, by this browser's clock (0 when unknown). */
export function runningFor(exec: Execution, now: number): number {
  return exec.seenAt === undefined ? 0 : Math.max(0, now - exec.seenAt);
}

/** The time of day it started, as this browser writes it ("14:02:07"). */
export function timeOfDay(at: number | undefined): string {
  if (at === undefined) return "";
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
