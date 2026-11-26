"use client";

/**
 * The run pane's Run Output tab (KOBE-804): one run's outputs (stream, display data, results,
 * errors with the traceback) through the notebook's renderer, the newest run unless the member
 * chose another in the Log. Clear empties the tab until the next run; a cut or timed-out run says
 * so (`ExecutionNote`).
 */
import { EraserIcon, SquareIcon } from "lucide-react";
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
export const OUTPUTS_FAILED =
  "Could not load this run's output. It is tried again when you come back to it.";
export const CLEARED_NOTE = "Output cleared. The next run shows here, or choose a run in the Log.";
/** KOBE-848: the agent ran the open file with `editor_run` (or `run_python` on it). */
export const AGENT_RUNNING_NOTE = "The agent started this run. Stop ends it.";

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
  loadFailed = false,
  path,
  teamId,
  onClear,
  onLatest,
  stop,
}: {
  /** The run shown; undefined before any run. */
  readonly exec: Execution | undefined;
  /** It is the newest run of the file. */
  readonly latest: boolean;
  readonly cleared: boolean;
  /** A stored run's outputs could not be read (KOBE-804 review R2-L1). */
  readonly loadFailed?: boolean;
  readonly path: string;
  readonly teamId: string;
  onClear(): void;
  onLatest(): void;
  /**
   * KOBE-848: the conversation owner's Stop, offered here while an agent-started run of this
   * file runs (undefined for a shared reader, who cannot stop it).
   */
  readonly stop?: { readonly onStop: () => void; readonly stopping: boolean };
}) {
  if (exec === undefined) return <p className="text-muted-foreground text-xs">{OUTPUT_EMPTY}</p>;
  if (cleared) return <p className="text-muted-foreground text-xs">{CLEARED_NOTE}</p>;
  return (
    <div className="flex flex-col gap-1" data-kaiju-run-output={path}>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-muted-foreground me-auto tabular-nums" data-kaiju-run-summary="">
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
      {exec.origin === "agent" && exec.finished === undefined && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-1 text-xs"
          data-kaiju-agent-run=""
        >
          <span className="text-muted-foreground me-auto">
            {stop === undefined ? "The agent started this run." : AGENT_RUNNING_NOTE}
          </span>
          {stop !== undefined && (
            <button
              type="button"
              className={TOOL_BUTTON}
              disabled={stop.stopping}
              aria-busy={stop.stopping}
              onClick={stop.onStop}
            >
              <SquareIcon aria-hidden className="size-3.5" />
              {stop.stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
      )}
      <ExecutionNote exec={exec} notebook={false} />
      {exec.outputsPending === true && (
        <p role="status" className="text-muted-foreground text-xs">
          {loadFailed ? OUTPUTS_FAILED : "Loading the output…"}
        </p>
      )}
      <NotebookOutputs outputs={exec.outputs} teamId={teamId} />
    </div>
  );
}
