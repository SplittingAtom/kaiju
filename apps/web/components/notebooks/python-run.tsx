"use client";

/**
 * A `.py` file in the file editor with Run (KOBE-465, NB6/NB13; layout KOBE-615): the editor's
 * toolbar gains Run, Run selection, Stop and Start or Restart with the kernel's state and the
 * newest run's clock, and a run splits the editor, code on top and the run pane below (KOBE-804:
 * Run Output, Log and Variables tabs); the split stays after the run and closes back to the full
 * height. The agent's `run_python {path}` runs of the same file show there too. KOBE-805: Run
 * saves unsaved changes first and then runs the saved file (the server reads the saved file);
 * Run selection runs only the selected lines of it; Shift+Enter and Mod+Enter run from the
 * editor. Loaded lazily by the file tab with the kernel.
 */
import { PanelBottomOpenIcon, PlayIcon, SquareIcon, TextSelectIcon } from "lucide-react";
import { useRef, useState } from "react";
import { kernelBusy } from "../../lib/notebooks/executions";
import { useDraft } from "../files/editor-save";
import type { ToolbarAction } from "../files/editor-toolbar";
import { FileEditor, type EditorRunContext, type FileEditorProps } from "../files/file-editor";
import { kernelActions, kernelBlocker, KernelNotices, KernelState } from "./kernel-bar";
import { RunClock, useRunPane } from "./run-pane";
import { useKernel, type KernelWiring } from "./use-kernel";

export const SAVE_AND_RUN_NOTE = "Run saves your changes first, then runs the saved file.";
export const SELECT_FIRST_NOTE = "Select some lines in the code (Raw) to run only those.";
export const SAVE_FAILED_NOTE = "Not run: your changes could not be saved (see above).";

export type PythonFileProps = FileEditorProps & {
  readonly kernel: KernelWiring | undefined;
};

export default function PythonFile({ kernel, ...editor }: PythonFileProps) {
  const { path } = editor;
  const k = useKernel(kernel);
  const [reveal, setReveal] = useState<{ line: number; seq: number } | undefined>(undefined);
  const [saveFailed, setSaveFailed] = useState(false);
  const pane = useRunPane({
    path,
    wiring: kernel,
    execs: k.execs,
    busy: k.busy,
    onGoTo: (line) => setReveal((r) => ({ line, seq: (r?.seq ?? 0) + 1 })),
  });
  const blocker = kernelBlocker(kernel);

  /** Saves first (KOBE-805 ac-1), then runs all of the file or the selected lines. */
  // One trigger, one run (review M1): from the click or key until the run request settles, and
  // then while the store says the kernel is busy, another trigger does nothing.
  const inFlight = useRef(false);
  const start = async (ctx: EditorRunContext, scope: "all" | "selection") => {
    if (blocker !== undefined || inFlight.current) return;
    if (kernel !== undefined && kernel.threadId !== null) {
      if (kernelBusy(kernel.runs.snapshot(), kernel.threadId)) return;
    }
    const lines = scope === "selection" ? ctx.selection : null;
    if (scope === "selection" && lines === null) return;
    inFlight.current = true;
    try {
      setSaveFailed(false);
      if (!(await ctx.saveFirst())) {
        setSaveFailed(true);
        return;
      }
      await k.run(lines === null ? { path } : { path, lines });
    } finally {
      inFlight.current = false;
    }
  };

  const actions = (ctx: EditorRunContext): ToolbarAction[] => {
    if (kernel?.readOnly === true) return [];
    const busyReason = k.busy ? "Code is running in this conversation's kernel." : undefined;
    const run: ToolbarAction = {
      id: "run",
      label: "Run",
      icon: PlayIcon,
      disabled: blocker !== undefined || k.busy,
      reason: blocker ?? busyReason,
      onSelect: () => void start(ctx, "all"),
    };
    const selection: ToolbarAction = {
      id: "run-selection",
      label: "Run selection",
      icon: TextSelectIcon,
      overflow: true,
      disabled: blocker !== undefined || k.busy || ctx.selection === null,
      reason: blocker ?? busyReason ?? SELECT_FIRST_NOTE,
      onSelect: () => void start(ctx, "selection"),
    };
    const stop: ToolbarAction = {
      id: "stop",
      label: "Stop",
      icon: SquareIcon,
      // Not twice while the interrupt is on its way (review L9).
      disabled: blocker !== undefined || k.note.kind === "working",
      busy: k.note.kind === "working",
      reason: blocker ?? "Stopping…",
      onSelect: () => void k.kernel("interrupt"),
    };
    const kernelControls = kernelActions({
      wiring: kernel,
      busy: k.busy,
      live: k.live,
      phase: k.phase,
      onStart: () => void k.start(),
      onKernel: (op) => void k.kernel(op),
    }).filter((a) => a.id !== "interrupt");
    const showPane: ToolbarAction[] = pane.open
      ? []
      : [
          {
            id: "run-pane",
            label: "Show run pane",
            icon: PanelBottomOpenIcon,
            overflow: true,
            onSelect: pane.show,
          },
        ];
    return [run, ...(k.busy ? [stop] : []), selection, ...kernelControls, ...showPane];
  };

  const dirty = useDraft(editor.drafts, path) !== undefined;
  return (
    <FileEditor
      {...editor}
      actions={actions}
      onRunKey={kernel?.readOnly === true ? undefined : (ctx, scope) => void start(ctx, scope)}
      reveal={reveal}
      status={
        <>
          <RunClock last={pane.last} now={pane.now} />
          <KernelState wiring={kernel} busy={k.busy} live={k.live} phase={k.phase} />
        </>
      }
      notices={
        <>
          {dirty && kernel?.readOnly !== true && blocker === undefined && (
            <p role="note" className="text-muted-foreground text-xs">
              {SAVE_AND_RUN_NOTE}
            </p>
          )}
          {saveFailed && (
            <p role="alert" className="text-destructive text-xs">
              {SAVE_FAILED_NOTE}
            </p>
          )}
          <KernelNotices wiring={kernel} note={k.note} execs={k.execs} path={path} />
        </>
      }
      output={
        pane.open
          ? { label: "Run output", header: pane.tabs, node: pane.panels, onClose: pane.close }
          : null
      }
    />
  );
}
