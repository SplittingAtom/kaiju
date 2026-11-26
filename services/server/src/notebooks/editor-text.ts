import {
  EDITOR_LOG_MAX_ENTRIES,
  EDITOR_PREVIEW_MAX_CHARS,
  EDITOR_READ_TEXT_MAX_BYTES,
  EDITOR_VARIABLES_MAX,
  type NotebookHistoryEntry,
  type NotebookOutput,
  type NotebookVariable,
  type NotebookVariablesResult,
} from "@kaiju/protocol";
import { toolText } from "./summary.js";

/**
 * The text the agent's `editor_read` gets (KOBE-848), built on the server from what the run pane
 * shows: Run Output (the newest run of the file), Log (its last runs) and Variables (the KOBE-816
 * snapshot: values only for exact built-ins and numpy/pandas summaries; credential-like names
 * withheld in the sandbox). Bounded here ({@link EDITOR_READ_TEXT_MAX_BYTES}); the extension
 * fences it as untrusted. Pure, so it is tested without a database.
 */
export interface EditorText {
  readonly text: string;
  readonly truncated: boolean;
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  ok: "done",
  error: "error",
  interrupted: "stopped",
  timeout: "timed out",
  restarted: "kernel restarted",
  failed: "could not run",
};

function durationOf(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One run in one line: when, who, how it ended, how long, its error. */
export function runLine(entry: NotebookHistoryEntry): string {
  const end = entry.finished;
  const who = entry.started.origin === "agent" ? "agent" : "user";
  const status =
    end === null
      ? entry.run_ended
        ? "ended without finishing"
        : "running"
      : (STATUS_WORDS[end.status] ?? end.status);
  const parts = [entry.started_at, `by ${who}`, status];
  if (end?.timing !== undefined) parts.push(durationOf(end.timing.duration_ms));
  if (end?.execution_count !== null && end?.execution_count !== undefined) {
    parts.push(`[${end.execution_count}]`);
  }
  const lines = entry.started.lines;
  if (lines !== undefined) parts.push(`lines ${lines.start}-${lines.end}`);
  if (end?.error !== undefined) {
    const line =
      end.error.line === undefined
        ? ""
        : ` at line ${lines === undefined ? end.error.line : end.error.line + lines.start - 1}`;
    parts.push(`${end.error.name.slice(0, 120)}${line}`);
  }
  if (end?.truncated === true) parts.push("output cut");
  return parts.join(" · ");
}

/** Cuts `text` to the answer's cap (UTF-8, never half a character). */
export function capText(text: string, max = EDITOR_READ_TEXT_MAX_BYTES): EditorText {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  const note = "\n[... cut to fit ...]";
  const room = max - Buffer.byteLength(note);
  const head = Buffer.from(text).subarray(0, room).toString("utf8").replace(/�+$/u, "");
  return { text: `${head}${note}`, truncated: true };
}

export function outputText(
  path: string,
  newest: NotebookHistoryEntry | undefined,
  outputs: readonly NotebookOutput[],
): EditorText {
  if (newest === undefined) {
    return { text: `${path} has not been run in this conversation yet.`, truncated: false };
  }
  const header = `Newest run of ${path}: ${runLine(newest)}`;
  // The header and a note use some room; the outputs get the rest.
  const body = toolText(outputs, EDITOR_READ_TEXT_MAX_BYTES - 1024);
  const text = body === "" ? `${header}\n(no output)` : `${header}\n\n${body}`;
  const capped = capText(text);
  return { text: capped.text, truncated: capped.truncated || newest.finished?.truncated === true };
}

export function logText(path: string, entries: readonly NotebookHistoryEntry[]): EditorText {
  if (entries.length === 0) {
    return { text: `${path} has not been run in this conversation yet.`, truncated: false };
  }
  const shown = entries.slice(0, EDITOR_LOG_MAX_ENTRIES);
  const lines = [`Runs of ${path}, newest first:`, ...shown.map((e) => `- ${runLine(e)}`)];
  if (entries.length > shown.length)
    lines.push(`(${entries.length - shown.length} older not shown)`);
  return capText(lines.join("\n"));
}

/** At most {@link EDITOR_PREVIEW_MAX_CHARS} characters on one line. */
export function preview(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  if (chars.length <= EDITOR_PREVIEW_MAX_CHARS) return flat;
  return `${chars.slice(0, EDITOR_PREVIEW_MAX_CHARS - 1).join("")}…`;
}

function variableLine(v: NotebookVariable): string {
  const type = v.module === undefined ? v.type : `${v.module}.${v.type}`;
  const facts: string[] = [];
  if (v.shape !== undefined) facts.push(`shape ${JSON.stringify(v.shape)}`);
  if (v.len !== undefined && v.shape === undefined) facts.push(`len ${v.len}`);
  if (v.dtype !== undefined) facts.push(`dtype ${v.dtype.slice(0, 40)}`);
  if (v.columns_total !== undefined) facts.push(`${v.columns_total} columns`);
  const head = `- ${v.name.slice(0, 100)}: ${type.slice(0, 100)}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;
  if (v.hidden === "name" || (v.hidden !== undefined && v.hidden !== "keys")) {
    return `${head} = (value hidden: credential-like name)`;
  }
  if (v.repr === "") return v.repr_error === undefined ? head : `${head} (value not shown)`;
  return `${head} = ${preview(v.repr)}`;
}

const MISSING: Readonly<Record<"no_kernel" | "busy" | "unavailable", string>> = {
  no_kernel: "The kernel is not running: nothing has run yet, or it stopped.",
  busy: "Code is running in the kernel; read the variables when it ends.",
  unavailable: "The kernel did not answer in time; the variables are not available now.",
};

export function variablesText(result: NotebookVariablesResult): EditorText {
  if (result.status !== "ok") return { text: MISSING[result.status], truncated: false };
  const shown = result.variables.slice(0, EDITOR_VARIABLES_MAX);
  const lines = [
    `Variables in the kernel (execution count ${result.execution_count ?? "none"}${result.stale === true ? `, taken at ${result.taken_at} before the latest code ran` : ""}):`,
  ];
  if (shown.length === 0) lines.push("(none)");
  lines.push(...shown.map(variableLine));
  const rest = result.variables.length - shown.length;
  if (rest > 0) lines.push(`(${rest} more not shown)`);
  const others = result.other.slice(0, EDITOR_VARIABLES_MAX);
  if (others.length > 0) {
    lines.push(
      `Also defined (names only): ${others.map((o) => `${o.name.slice(0, 100)} (${o.kind})`).join(", ")}`,
    );
  }
  const capped = capText(lines.join("\n"));
  return {
    text: capped.text,
    truncated:
      capped.truncated || rest > 0 || result.truncated || result.other.length > others.length,
  };
}
