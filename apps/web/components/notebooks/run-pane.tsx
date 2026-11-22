"use client";

/**
 * A `.py` file's run pane under the code (KOBE-804): three tabs, Run Output (the shown run's
 * outputs), Log (this file's runs in this conversation) and Variables (the kernel's variables, live
 * from the sandbox). The tabs follow the app's tablist pattern (`shell/rail-tabs.tsx`): Left and
 * Right move (wrapping), Home and End go to the ends, only the chosen tab is in the Tab order, and
 * the panels stay mounted. The chosen tab is remembered per member in this browser, like the
 * split's height (`split-pane.tsx`); the run shown, the Log choice and the Variables filter, sort
 * and open rows are kept per file while the editor is open. A dot on a tab says it has something
 * new (new output; a failed run) while another tab is chosen.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { fileRuns, lastFinished, type Execution } from "../../lib/notebooks/executions";
import {
  failed,
  formatClock,
  formatDuration,
  runningFor,
  statusWord,
} from "../../lib/notebooks/run-log";
import { cn } from "../../lib/utils";
import { RunLogPanel } from "./run-log-panel";
import { RunOutputPanel } from "./run-output-panel";
import type { KernelWiring } from "./use-kernel";
import { useVariables } from "./use-variables";
import { VARIABLES_VIEW, VariablesPanel, type VariablesView } from "./variables-panel";

export type RunTab = "output" | "log" | "variables";
export const RUN_TABS: readonly RunTab[] = ["output", "log", "variables"];
export const RUN_TAB_LABELS: Readonly<Record<RunTab, string>> = {
  output: "Run Output",
  log: "Log",
  variables: "Variables",
};
export const RUN_TAB_KEY = "kobe.pythonRun.tab";

export function readRunTab(): RunTab {
  try {
    const raw = window.localStorage.getItem(RUN_TAB_KEY);
    return RUN_TABS.find((t) => t === raw) ?? "output";
  } catch {
    return "output";
  }
}

function writeRunTab(tab: RunTab): void {
  try {
    window.localStorage.setItem(RUN_TAB_KEY, tab);
  } catch {
    // Storage blocked (a private window): the choice lasts this page only.
  }
}

/** The time now, ticking every second while `running` (a run's live clock). */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

function RunTabList({
  tab,
  onTab,
  ids,
  badges,
}: {
  readonly tab: RunTab;
  onTab(tab: RunTab): void;
  readonly ids: Readonly<Record<RunTab, { tab: string; panel: string }>>;
  readonly badges: Readonly<Record<RunTab, string | null>>;
}) {
  const buttons = useRef(new Map<RunTab, HTMLButtonElement>());
  const go = (next: RunTab) => {
    onTab(next);
    buttons.current.get(next)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const at = RUN_TABS.indexOf(tab);
    const n = RUN_TABS.length;
    const next =
      e.key === "ArrowRight"
        ? RUN_TABS[(at + 1) % n]
        : e.key === "ArrowLeft"
          ? RUN_TABS[(at - 1 + n) % n]
          : e.key === "Home"
            ? RUN_TABS[0]
            : e.key === "End"
              ? RUN_TABS[n - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    go(next);
  };
  return (
    <div
      role="tablist"
      aria-label="Run output, log and variables"
      className="flex min-w-0 items-center gap-0.5"
      onKeyDown={onKeyDown}
    >
      {RUN_TABS.map((id) => (
        <button
          key={id}
          ref={(el) => {
            if (el) buttons.current.set(id, el);
            else buttons.current.delete(id);
          }}
          type="button"
          role="tab"
          id={ids[id].tab}
          aria-selected={tab === id}
          aria-controls={ids[id].panel}
          tabIndex={tab === id ? 0 : -1}
          data-kobe-run-tab={id}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring -mb-px inline-flex items-center gap-1 border-b-2 border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:outline-none",
            "aria-selected:border-primary aria-selected:text-foreground",
          )}
          onClick={() => go(id)}
        >
          {RUN_TAB_LABELS[id]}
          {badges[id] !== null && (
            <>
              <span aria-hidden className="bg-primary size-1.5 rounded-full" data-kobe-badge="" />
              <span className="sr-only">{`, ${badges[id]}`}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

/** What the pane keeps per file. */
interface FileMemory {
  /** Shown while the pane was not closed after this run (undefined: never closed). */
  readonly closedAt: string | undefined;
  /** Opened without a new run (the toolbar's Run pane). */
  readonly open: boolean;
  /** The run chosen in the Log, while no newer run came. */
  readonly pick: { readonly id: string; readonly against: string | undefined } | null;
  readonly cleared: string | null;
  readonly variables: VariablesView;
}

const BLANK: FileMemory = {
  closedAt: undefined,
  open: false,
  pick: null,
  cleared: null,
  variables: VARIABLES_VIEW,
};

const outputMark = (e: Execution | undefined) =>
  e === undefined ? "" : `${e.execId}:${e.outputs.length}:${e.finished?.status ?? ""}`;
const failMark = (e: Execution | undefined) => (e !== undefined && failed(e) ? e.execId : "");

export function useRunPane({
  path,
  wiring,
  execs,
  busy,
  onGoTo,
}: {
  readonly path: string;
  readonly wiring: KernelWiring | undefined;
  readonly execs: readonly Execution[];
  /** Code runs in the thread's kernel. */
  readonly busy: boolean;
  onGoTo(line: number): void;
}) {
  const threadId = wiring?.threadId ?? null;
  const runs = threadId === null ? [] : fileRuns(execs, threadId, path);
  const last = runs[0];
  const [tab, setTabState] = useState<RunTab>(readRunTab);
  const [memory, setMemory] = useState<Readonly<Record<string, FileMemory>>>({});
  const mem = memory[path] ?? BLANK;
  const remember = (change: Partial<FileMemory>) =>
    setMemory((m) => ({ ...m, [path]: { ...(m[path] ?? BLANK), ...change } }));
  const open = mem.open || (last !== undefined && last.execId !== mem.closedAt);
  const picked =
    mem.pick !== null && mem.pick.against === last?.execId
      ? runs.find((e) => e.execId === mem.pick?.id)
      : undefined;
  const shown = picked ?? last;
  const setTab = (next: RunTab) => {
    setTabState(next);
    writeRunTab(next);
  };

  // New output and failed runs while another tab is chosen: a dot on the tab.
  const marks = { output: outputMark(last), log: failMark(last) };
  const [seen, setSeen] = useState(marks);
  useEffect(() => {
    if (tab === "output" && seen.output !== marks.output)
      setSeen((s) => ({ ...s, output: marks.output }));
    if (tab === "log" && seen.log !== marks.log) setSeen((s) => ({ ...s, log: marks.log }));
  }, [tab, seen, marks.output, marks.log]);
  const badges: Record<RunTab, string | null> = {
    output:
      tab !== "output" && marks.output !== "" && marks.output !== seen.output ? "new output" : null,
    log: tab !== "log" && marks.log !== "" && marks.log !== seen.log ? "a run failed" : null,
    variables: null,
  };

  const running = last !== undefined && last.finished === undefined;
  const now = useNow(running);
  const variables = useVariables({
    wiring,
    active: open && tab === "variables",
    busy,
    followKey: threadId === null ? "" : (lastFinished(execs, threadId)?.execId ?? ""),
  });

  const base = useId();
  const ids = Object.fromEntries(
    RUN_TABS.map((t) => [t, { tab: `${base}-${t}-tab`, panel: `${base}-${t}-panel` }]),
  ) as Record<RunTab, { tab: string; panel: string }>;
  const panel = (t: RunTab) => ({
    role: "tabpanel" as const,
    id: ids[t].panel,
    "aria-labelledby": ids[t].tab,
    hidden: tab !== t,
    tabIndex: 0,
    "data-kobe-run-panel": t,
    className: "min-w-0 focus-visible:outline-none",
  });

  const tabs = <RunTabList tab={tab} onTab={setTab} ids={ids} badges={badges} />;
  const panels = (
    <div className="flex min-w-0 flex-col p-1">
      <div {...panel("output")}>
        <RunOutputPanel
          exec={shown}
          latest={shown === last}
          cleared={shown !== undefined && mem.cleared === shown.execId}
          path={path}
          teamId={wiring?.teamId ?? ""}
          onClear={() => remember({ cleared: shown?.execId ?? null })}
          onLatest={() => remember({ pick: null })}
        />
      </div>
      <div {...panel("log")}>
        <RunLogPanel
          runs={runs}
          shownId={shown?.execId}
          now={now}
          onShow={(id) => {
            remember({ pick: { id, against: last?.execId }, cleared: null });
            setTab("output");
          }}
          onGoTo={onGoTo}
        />
      </div>
      <div {...panel("variables")}>
        <VariablesPanel
          state={variables}
          busy={busy}
          view={mem.variables}
          onView={(v) => remember({ variables: v })}
        />
      </div>
    </div>
  );
  return {
    open,
    last,
    now,
    show: () => remember({ open: true }),
    close: () => remember({ open: false, closedAt: last?.execId }),
    tabs,
    panels,
  };
}

/**
 * The newest run's clock in the toolbar (KOBE-805): "Running 0:07" live, then how it ended and how
 * long it took ("Done in 1.2 s").
 */
export function RunClock({
  last,
  now,
}: {
  readonly last: Execution | undefined;
  readonly now: number;
}) {
  if (last === undefined) return null;
  let text: string;
  if (last.finished === undefined) {
    text = `Running ${formatClock(runningFor(last, now))}`;
  } else {
    const took = last.finished.timing?.durationMs;
    const word = statusWord(last);
    text =
      took === undefined
        ? word
        : `${word} ${failed(last) ? "after" : "in"} ${formatDuration(took)}`;
  }
  return (
    <span
      className="text-muted-foreground text-xs tabular-nums"
      data-kobe-run-clock={last.finished?.status ?? "running"}
      aria-live="off"
    >
      {text}
    </span>
  );
}
