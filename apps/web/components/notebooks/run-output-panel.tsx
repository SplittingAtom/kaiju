"use client";

/**
 * The run pane's Run Output tab (KOBE-804): one run's outputs (stream, display data, results,
 * errors with the traceback) through the notebook's renderer, the newest run unless the member
 * chose another in the Log. Clear empties the tab until the next run; a cut or timed-out run says
 * so (`ExecutionNote`).
 */
import { EraserIcon } from "lucide-react";
import type { Execution } from "../../lib/notebooks/executions";
import {
  formatDuration,
  startedAt,
  statusWord,
  timeOfDay,
  whoRan,
} from "../../lib/notebooks/run-log";
import { TOOL_BUTTON } from "../files/editor-toolbar";
import { ExecutionNote } from "./execution-status";
import { NotebookOutputs } from "./output-view";

export const OUTPUT_EMPTY =
  "Run Output shows what the code prints and returns: text, tables, plots and errors. Run the file to see it here.";
export const CLEARED_NOTE = "Output cleared. The next run shows here, or choose a run in the Log.";

function summary(exec: Execution): string {
  const count = exec.finished?.executionCount;
  const took = exec.finished?.timing?.durationMs;
  return [
    count === null || count === undefined ? "" : `[${count}]`,
    whoRan(exec),
    timeOfDay(startedAt(exec)),
    statusWord(exec),
    took === undefined ? "" : formatDuration(took),
  ]
    .filter((p) => p !== "")
    .join(" · ");
}

export function RunOutputPanel({
  exec,
  latest,
  cleared,
  path,
  teamId,
  onClear,
  onLatest,
}: {
  /** The run shown; undefined before any run. */
  readonly exec: Execution | undefined;
  /** It is the newest run of the file. */
  readonly latest: boolean;
  readonly cleared: boolean;
  readonly path: string;
  readonly teamId: string;
  onClear(): void;
  onLatest(): void;
}) {
  if (exec === undefined) return <p className="text-muted-foreground text-xs">{OUTPUT_EMPTY}</p>;
  if (cleared) return <p className="text-muted-foreground text-xs">{CLEARED_NOTE}</p>;
  return (
    <div className="flex flex-col gap-1" data-kobe-run-output={path}>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-muted-foreground me-auto tabular-nums" data-kobe-run-summary="">
          {latest ? summary(exec) : `Earlier run: ${summary(exec)}`}
        </span>
        {!latest && (
          <button type="button" className={TOOL_BUTTON} onClick={onLatest}>
            Show the latest run
          </button>
        )}
        <button
          type="button"
          className={TOOL_BUTTON}
          title="Clear the output (the run stays in the Log)"
          onClick={onClear}
        >
          <EraserIcon aria-hidden className="size-3.5" />
          Clear
        </button>
      </div>
      <ExecutionNote exec={exec} notebook={false} />
      <NotebookOutputs outputs={exec.outputs} teamId={teamId} />
    </div>
  );
}
