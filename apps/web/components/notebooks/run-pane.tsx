"use client";

/**
 * A `.py` file's run pane under the code (KOBE-804): three tabs, Run Output (the shown run's
 * outputs), Log (this file's runs in this conversation) and Variables (the kernel's variables, live
 * from the sandbox). The tabs follow the app's tablist pattern (`shell/rail-tabs.tsx`): Left and Right move (wrapping), Home and End go to the ends, only the chosen tab is in the Tab order, and
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
export const RUN_TAB_KEY = "kaiju.pythonRun.tab";

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
          data-kaiju-run-tab={id}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring -mb-px inline-flex items-center gap-1 border-b-2 border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:outline-none",
            "aria-selected:border-primary aria-selected:text-foreground",
          )}
          onClick={() => go(id)}
        >
          {RUN_TAB_LABELS[id]}
          {badges[id] !== null && (
            <>
              <span aria-hidden className="bg-primary size-1.5 rounded-full" data-kaiju-badge="" />
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

// A run read from the stored history (`outputsPending` set) is not news: no dot for it.
const seeded = (e: Execution | undefined) => e?.outputsPending !== undefined;
const outputMark = (e: Execution | undefined) =>
  e === undefined || seeded(e) ? "" : `${e.execId}:${e.outputs.length}:${e.finished?.status ?? ""}`;
const failMark = (e: Execution | undefined) =>
  e !== undefined && !seeded(e) && failed(e) ? e.execId : "";

export function useRunPane({
  path,
  wiring,
  execs,
  busy,
  onGoTo,
  stop,
}: {
  readonly path: string;
  readonly wiring: KernelWiring | undefined;
  readonly execs: readonly Execution[];
  /** Code runs in the thread's kernel. */
  readonly busy: boolean;
  onGoTo(line: number): void;
  /** KOBE-848: the owner's Stop, shown in Run Output while an agent-started run runs. */
  readonly stop?: { readonly onStop: () => void; readonly stopping: boolean };
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

  // The Log after a reload (review M2): the file's stored runs, once per file and thread, when
  // the pane opens; a shown run read that way gets its outputs when it is shown.
  const loaded = useRef(new Set<string>());
  const owner = wiring !== undefined && threadId !== null && wiring.readOnly !== true;
  useEffect(() => {
    if (!open || !owner || wiring === undefined || threadId === null) return;
    const key = `${threadId}\u0000${path}`;
    if (loaded.current.has(key)) return;
    loaded.current.add(key);
    void wiring.api.history(threadId, path).then((res) => {
      if (res.ok) wiring.runs.seed(threadId, res.data);
      else loaded.current.delete(key);
    });
  }, [open, owner, wiring, threadId, path]);
  // Asked while Run Output shows it; a failed read says so and is tried again the next time the
  // tab shows it (review R2-L1).
  const pendingId =
    shown?.outputsPending === true && tab === "output" && open ? shown.execId : undefined;
  const [outputsFailed, setOutputsFailed] = useState<string | null>(null);
  useEffect(() => {
    if (pendingId === undefined || wiring === undefined || threadId === null) return;
    let live = true;
    void wiring.api.outputs(threadId, pendingId).then((res) => {
      if (!live) return;
      if (res.ok) wiring.runs.fillOutputs(pendingId, res.data);
      setOutputsFailed(res.ok ? null : pendingId);
    });
    return () => {
      live = false;
      setOutputsFailed(null);
    };
  }, [pendingId, wiring, threadId]);

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
    "data-kaiju-run-panel": t,
    className: "min-w-0 focus-visible:outline-none",
  });

  // Choosing a run in the Log shows Run Output: focus moves to its panel (the pressed entry is
  // now hidden), review M3.
  const [focusOutput, setFocusOutput] = useState(0);
  const outputPanelId = ids.output.panel;
  useEffect(() => {
    if (focusOutput > 0) document.getElementById(outputPanelId)?.focus();
  }, [focusOutput, outputPanelId]);

  const tabs = <RunTabList tab={tab} onTab={setTab} ids={ids} badges={badges} />;
  const panels = (
    <div className="flex min-w-0 flex-col p-1">
      <div {...panel("output")}>
        <RunOutputPanel
          exec={shown}
          latest={shown === last}
          cleared={shown !== undefined && mem.cleared === shown.execId}
          loadFailed={shown !== undefined && outputsFailed === shown.execId}
          path={path}
          teamId={wiring?.teamId ?? ""}
          onClear={() => remember({ cleared: shown?.execId ?? null })}
          onLatest={() => remember({ pick: null })}
          {...(stop === undefined || wiring?.readOnly === true ? {} : { stop })}
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
            setFocusOutput((n) => n + 1);
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
      data-kaiju-run-clock={last.finished?.status ?? "running"}
      aria-live="off"
    >
      {text}
    </span>
  );
}
