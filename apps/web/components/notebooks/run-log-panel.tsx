"use client";

/**
 * The run pane's Log tab (KOBE-804): this file's runs in this conversation, newest first, from the
 * run events this page has seen (KOBE-803's timing and error on `notebook.finished`). Each entry
 * says when, who (you or the agent), how it ended, how long it took and the execution count;
 * choosing one shows its output in the Run Output tab. A failed run names the error and offers to
 * go to its line in the editor.
 */
import type { Execution } from "../../lib/notebooks/executions";
import {
  errorLine,
  failed,
  formatClock,
  formatDuration,
  runningFor,
  startedAt,
  statusWord,
  timeOfDay,
  whoRan,
} from "../../lib/notebooks/run-log";
import { visibleText } from "../../lib/notebooks/variables";

export const LOG_EMPTY =
  "The log lists each run of this file in this conversation, yours and the agent's, with how it ended and how long it took.";

function duration(exec: Execution, now: number): string {
  const timing = exec.finished?.timing;
  if (timing !== undefined) return formatDuration(timing.durationMs);
  if (exec.finished !== undefined) return "";
  return formatClock(runningFor(exec, now));
}

function Entry({
  exec,
  shown,
  now,
  onShow,
  onGoTo,
}: {
  readonly exec: Execution;
  readonly shown: boolean;
  readonly now: number;
  onShow(): void;
  onGoTo(line: number): void;
}) {
  const count = exec.finished?.executionCount;
  const error = exec.finished?.error;
  const line = errorLine(exec);
  const bad = failed(exec);
  const took = duration(exec, now);
  const parts = [
    timeOfDay(startedAt(exec)),
    whoRan(exec),
    statusWord(exec),
    took,
    count === null || count === undefined ? "" : `[${count}]`,
    exec.lines === undefined ? "" : `lines ${exec.lines.start}–${exec.lines.end}`,
  ].filter((p) => p !== "");
  return (
    <li
      className="flex flex-wrap items-center gap-x-2 border-b py-0.5"
      data-kobe-log-entry={exec.execId}
      data-status={exec.finished?.status ?? "running"}
    >
      <button
        type="button"
        aria-current={shown || undefined}
        className="hover:bg-muted aria-[current]:bg-muted flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-start tabular-nums"
        title="Show this run's output"
        onClick={onShow}
      >
        <span className={bad ? "text-destructive" : undefined}>{parts.join(" · ")}</span>
      </button>
      {error !== undefined && (
        <span className="text-destructive text-xs">
          {visibleText(error.name)}
          {line === undefined ? "" : ` on line ${line}`}
        </span>
      )}
      {line !== undefined && (
        <button
          type="button"
          className="hover:bg-muted rounded-md border px-1.5 text-xs"
          aria-label={`Go to line ${line}`}
          onClick={() => onGoTo(line)}
        >
          Go to line {line}
        </button>
      )}
    </li>
  );
}

export function RunLogPanel({
  runs,
  shownId,
  now,
  onShow,
  onGoTo,
}: {
  /** Newest first. */
  readonly runs: readonly Execution[];
  readonly shownId: string | undefined;
  readonly now: number;
  onShow(execId: string): void;
  onGoTo(line: number): void;
}) {
  if (runs.length === 0) return <p className="text-muted-foreground text-xs">{LOG_EMPTY}</p>;
  return (
    <ol aria-label="Runs of this file, newest first" className="m-0 list-none p-0 text-xs">
      {runs.map((exec) => (
        <Entry
          key={exec.execId}
          exec={exec}
          shown={exec.execId === shownId}
          now={now}
          onShow={() => onShow(exec.execId)}
          onGoTo={onGoTo}
        />
      ))}
    </ol>
  );
}
