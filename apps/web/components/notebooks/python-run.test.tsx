// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditDraftStore } from "../../lib/files/editor-state";
import { sha256Hex } from "../../lib/files/editor";
import { must } from "../../lib/testing/must";
import { SAVE_AND_RUN_NOTE, SAVE_FAILED_NOTE, SELECT_FIRST_NOTE } from "./python-run";
import { TIMEOUT_NOTE, TRUNCATED_NOTE } from "./execution-status";
import { NO_THREAD_NOTE, RESTART_PROMPT } from "./kernel-bar";
import type { Kernel } from "./testing";
import { ev, execId, renderPython, runId, THREAD } from "./testing";

/** KOBE-465 ac-3, KOBE-615 ac-7/ac-8, KOBE-805: a `.py` file's Run controls and the split. */
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const PATH = "src/job.py";
const toolbar = () => screen.getByRole("toolbar", { name: "job.py view" });
const button = (name: string) => within(toolbar()).getByRole("button", { name });

function finish(kernel: Kernel, n = 1, extra: Record<string, unknown> = {}) {
  act(() =>
    kernel.store.apply(THREAD, [
      ev(runId(n), "notebook.output", {
        exec_id: execId(n),
        index: 0,
        output: { output_type: "stream", name: "stdout", text: "hello\n" },
      }),
      ev(runId(n), "notebook.output", {
        exec_id: execId(n),
        index: 1,
        output: { output_type: "error", ename: "KeyError", evalue: "'k'", traceback: [] },
      }),
      ev(runId(n), "notebook.finished", {
        exec_id: execId(n),
        status: "error",
        execution_count: 3,
        outputs: 2,
        truncated: false,
        saved: null,
        ...extra,
      }),
    ]),
  );
}

async function editorView(): Promise<EditorView> {
  const host = await waitFor(() => must(document.querySelector<HTMLElement>(".cm-editor")));
  return must(EditorView.findFromDOM(host));
}

function press(view: EditorView, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean }) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  act(() => void runScopeHandlers(view, event, "editor"));
}

describe("Run for .py files (KOBE-615 ac-7, ac-8)", () => {
  it("Run is in the toolbar; a run splits the editor and shows its outputs live", async () => {
    const { kernel } = await renderPython();
    const user = userEvent.setup();
    expect(screen.queryByRole("region", { name: "Run output" })).toBeNull();
    for (const name of ["Run", "Run selection", "Start", "Save", "Save As"]) {
      expect(button(name)).toBeTruthy();
    }
    await user.click(button("Run"));
    await waitFor(() => expect(kernel.runs).toEqual([{ path: PATH }]));
    const pane = screen.getByRole("region", { name: "Run output" });
    expect(await within(pane).findByText("Running…")).toBeTruthy();
    const split = pane.closest("[data-kaiju-split]") as HTMLElement;
    expect(split.querySelector("[data-kaiju-split-top] [data-kaiju-editor-body]")).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the code and its output" })).toBeTruthy();
    finish(kernel);
    expect(await within(pane).findByText("KeyError: 'k'")).toBeTruthy();
    expect(within(pane).getByText("hello")).toBeTruthy();
    expect(within(pane).queryByText("Running…")).toBeNull();
    expect(within(pane).queryByText(/not saved/u)).toBeNull();
    expect(button("Restart")).toBeTruthy();
    expect(toolbar().querySelector("[data-kaiju-kernel]")).toBeTruthy();
  });

  it("the output stays after the run, collapses, and closes back to the full height", async () => {
    const { kernel } = await renderPython();
    const user = userEvent.setup();
    await user.click(button("Run"));
    finish(kernel);
    const pane = await screen.findByRole("region", { name: "Run output" });
    await user.click(within(pane).getByRole("button", { name: "Collapse the output" }));
    expect(screen.queryByRole("separator", { name: "Resize the code and its output" })).toBeNull();
    expect(within(pane).queryByText("hello")).toBeNull();
    await user.click(within(pane).getByRole("button", { name: "Expand the output" }));
    expect(within(pane).getByText("hello")).toBeTruthy();
    await user.click(within(pane).getByRole("button", { name: "Close the output" }));
    expect(screen.queryByRole("region", { name: "Run output" })).toBeNull();
    await user.click(button("Run"));
    expect(await screen.findByRole("region", { name: "Run output" })).toBeTruthy();
  });

  it("the divider resizes from the keyboard and is remembered per viewer", async () => {
    const { kernel } = await renderPython();
    const user = userEvent.setup();
    await user.click(button("Run"));
    finish(kernel);
    const divider = await screen.findByRole("separator", {
      name: "Resize the code and its output",
    });
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    act(() => divider.focus());
    await user.keyboard("{ArrowDown}");
    expect(localStorage.getItem("kaiju.fileEditor.split")).toBe("55");
    await user.keyboard("{Enter}");
    expect(localStorage.getItem("kaiju.fileEditor.split")).toBeNull();
  });

  it("has no Run or kernel controls for a shared reader", async () => {
    await renderPython({ readOnly: true });
    for (const name of ["Run", "Run selection", "Stop", "Interrupt", "Restart", "Start"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("needs a conversation: disabled with the reason; the agent's runs show in the split", async () => {
    const { kernel } = await renderPython({ threadId: null });
    for (const name of ["Run", "Run selection", "Start"]) {
      expect(button(name).hasAttribute("disabled")).toBe(true);
      expect(button(name).getAttribute("title")).toBe(NO_THREAD_NOTE);
    }
    cleanup();
    const { kernel: k2 } = await renderPython();
    act(() =>
      k2.store.apply(THREAD, [
        ev(runId(5), "notebook.started", {
          exec_id: execId(5),
          origin: "agent",
          tool_call_id: "t1",
          path: PATH,
        }),
      ]),
    );
    const pane = await screen.findByRole("region", { name: "Run output" });
    expect(within(pane).getByText("Agent run: Running…")).toBeTruthy();
    expect(kernel.runs).toEqual([]);
  });
});

describe("Run what you see (KOBE-805)", () => {
  it("ac-1: Run saves unsaved changes first, then runs the saved file, and says so", async () => {
    const drafts = new EditDraftStore();
    const base = await sha256Hex(new TextEncoder().encode("print(1)\n"));
    drafts.set(PATH, { text: "print(2)\n", baseSha256: base });
    const { kernel, workspace } = await renderPython({ drafts });
    const user = userEvent.setup();
    expect(screen.getByText(SAVE_AND_RUN_NOTE)).toBeTruthy();
    expect(button("Run").hasAttribute("disabled")).toBe(false);
    await user.click(button("Run"));
    await waitFor(() => expect(kernel.runs).toEqual([{ path: PATH }]));
    expect(workspace.saves).toEqual([{ base, text: "print(2)\n" }]);
    expect(drafts.get(PATH)).toBeUndefined();
    expect(screen.queryByText(SAVE_AND_RUN_NOTE)).toBeNull();
  });

  it("ac-1: a save that fails runs nothing and says why", async () => {
    const drafts = new EditDraftStore();
    drafts.set(PATH, { text: "print(2)\n", baseSha256: "a".repeat(64) });
    const { kernel } = await renderPython({ drafts });
    const user = userEvent.setup();
    await user.click(button("Run"));
    expect(await screen.findByText(SAVE_FAILED_NOTE)).toBeTruthy();
    expect(kernel.runs).toEqual([]);
  });

  it("ac-2: Shift+Enter and Mod+Enter run from the editor; Mod+S saves", async () => {
    const drafts = new EditDraftStore();
    const { kernel, workspace } = await renderPython({ drafts });
    const view = await editorView();
    press(view, "Enter", { shiftKey: true });
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    // Opening the output keeps the same editor (its cursor and undo history).
    expect(await editorView()).toBe(view);
    finish(kernel);
    press(view, "Enter", { ctrlKey: true });
    await waitFor(() => expect(kernel.runs).toEqual([{ path: PATH }, { path: PATH }]));
    finish(kernel, 2);
    act(() => view.dispatch({ changes: { from: 0, insert: "x = 1\n" } }));
    expect(drafts.get(PATH)).toBeDefined();
    press(view, "s", { ctrlKey: true });
    await waitFor(() => expect(workspace.saves).toHaveLength(1));
    expect(workspace.saves[0]?.text).toBe("x = 1\nprint(1)\n");
  });

  it("ac-3: Stop and a live clock while it runs; how it ended and how long after", async () => {
    const { kernel } = await renderPython();
    const user = userEvent.setup();
    expect(within(toolbar()).queryByRole("button", { name: "Stop" })).toBeNull();
    await user.click(button("Run"));
    const clock = await waitFor(() => must(toolbar().querySelector("[data-kaiju-run-clock]")));
    expect(clock.textContent).toMatch(/^Running \d+:\d\d$/u);
    expect(button("Run").hasAttribute("disabled")).toBe(true);
    await user.click(button("Stop"));
    expect(kernel.ops).toEqual(["interrupt"]);
    finish(kernel, 1, {
      timing: {
        started_at: "2026-11-22T10:00:00Z",
        finished_at: "2026-11-22T10:00:01.5Z",
        duration_ms: 1500,
      },
    });
    expect(toolbar().querySelector("[data-kaiju-run-clock]")?.textContent).toBe(
      "Error after 1.5 s",
    );
    expect(within(toolbar()).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("ac-4: Run selection runs the selected lines; an error's line maps back to the file", async () => {
    const { kernel } = await renderPython({ text: "a = 1\nb = 2\nc = d\n" });
    const user = userEvent.setup();
    expect(button("Run selection").hasAttribute("disabled")).toBe(true);
    expect(button("Run selection").getAttribute("title")).toBe(SELECT_FIRST_NOTE);
    const view = await editorView();
    act(() => view.dispatch({ selection: { anchor: 6, head: 17 } }));
    await user.click(button("Run selection"));
    await waitFor(() => expect(kernel.runs).toEqual([{ path: PATH, lines: { start: 2, end: 3 } }]));
    finish(kernel, 1, { error: { name: "NameError", line: 2 } });
    await user.click(screen.getByRole("tab", { name: /^Log/u }));
    expect(screen.getByText("NameError on line 3")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Go to line 3" }));
    await waitFor(() => expect(view.state.selection.main.head).toBe(12));
  });

  it("ac-4: Restart asks first that variables are cleared, then says the kernel is not started", async () => {
    const { kernel } = await renderPython();
    const user = userEvent.setup();
    await user.click(button("Run"));
    finish(kernel);
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    window.confirm = confirm;
    await user.click(button("Restart"));
    expect(confirm).toHaveBeenCalledWith(RESTART_PROMPT);
    expect(RESTART_PROMPT).toMatch(/variables are cleared/u);
    expect(kernel.ops).toEqual([]);
    await user.click(button("Restart"));
    expect(kernel.ops).toEqual(["restart"]);
    await waitFor(() =>
      expect(toolbar().querySelector("[data-kaiju-kernel]")?.textContent).toBe(
        "Kernel not started",
      ),
    );
  });

  it("ac-6: a run cut at the output cap or stopped at its time limit says what to do", async () => {
    const { kernel } = await renderPython();
    const user = userEvent.setup();
    await user.click(button("Run"));
    act(() =>
      kernel.store.apply(THREAD, [
        ev(runId(1), "notebook.finished", {
          exec_id: execId(1),
          status: "timeout",
          execution_count: null,
          outputs: 0,
          truncated: true,
          saved: null,
        }),
      ]),
    );
    const pane = screen.getByRole("region", { name: "Run output" });
    const note = within(pane).getByText(/time limit/u);
    expect(note.textContent).toContain(TIMEOUT_NOTE);
    expect(note.textContent).toContain(TRUNCATED_NOTE);
    expect(TRUNCATED_NOTE).toMatch(/200 outputs and 2(\.0)? MB/u);
  });
});

describe("one trigger, one run (KOBE-805 review M1)", () => {
  /** The next `run` call waits until the returned function is called. */
  function holdRun(kernel: Kernel) {
    let release: () => void = () => {};
    const original = kernel.api.run;
    kernel.api.run = async (thread, body) => {
      await new Promise<void>((r) => (release = r));
      return original(thread, body);
    };
    return () => release();
  }

  it("a double click runs the file once, even when the script ends at once", async () => {
    const { kernel } = await renderPython();
    const release = holdRun(kernel);
    const user = userEvent.setup();
    await user.dblClick(button("Run"));
    await user.click(button("Run"));
    await act(async () => release());
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    // A script shorter than the busy retries: it ends before a second request could be refused.
    finish(kernel);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(kernel.runs).toHaveLength(1);
  });

  it("a held Shift+Enter (key repeat) runs once", async () => {
    const { kernel } = await renderPython();
    const view = await editorView();
    const key = (repeat: boolean) =>
      act(() => {
        view.contentDOM.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            shiftKey: true,
            repeat,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    key(false);
    key(true);
    key(true);
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    finish(kernel);
    key(true);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(kernel.runs).toHaveLength(1);
    expect(view.state.doc.toString()).toBe("print(1)\n");
  });

  it("unsaved edits: two triggers save once and run once, with no failed-save note", async () => {
    const drafts = new EditDraftStore();
    const base = await sha256Hex(new TextEncoder().encode("print(1)\n"));
    drafts.set(PATH, { text: "print(2)\n", baseSha256: base });
    const { kernel, workspace } = await renderPython({ drafts });
    const user = userEvent.setup();
    await user.dblClick(button("Run"));
    await waitFor(() => expect(kernel.runs).toHaveLength(1));
    expect(workspace.saves).toHaveLength(1);
    expect(screen.queryByText(SAVE_FAILED_NOTE)).toBeNull();
  });
});

describe("Python opens in Raw (KOBE-802)", () => {
  const editor = () => document.querySelector("[data-kaiju-code-editor]");

  it("opens in the code editor; an explicit switch to Rendered is kept when it reopens", async () => {
    const drafts = new EditDraftStore();
    await renderPython({ drafts });
    const user = userEvent.setup();
    await waitFor(() => expect(editor()).toBeTruthy());
    const mode = screen.getByRole("switch", { name: "Raw" });
    expect(mode.getAttribute("aria-checked")).toBe("true");
    await user.click(mode);
    expect(editor()).toBeNull();
    cleanup();
    await renderPython({ drafts });
    expect(screen.getByRole("switch", { name: "Raw" }).getAttribute("aria-checked")).toBe("false");
    expect(editor()).toBeNull();
  });

  it("does not take the cursor unless the member opened the tab", async () => {
    await renderPython();
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(editor()?.contains(document.activeElement)).toBe(false);
  });

  it("a read-only file opens in Raw, read-only", async () => {
    await renderPython({ readOnly: true });
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Raw" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("kernel completion in a .py file (KOBE-808)", () => {
  const indicator = () => document.querySelector("[data-kaiju-kernel-completion]");
  const editor = () => document.querySelector("[data-kaiju-code-editor]");

  it("the owner's editor completes from the conversation's kernel and says when it is off", async () => {
    const { kernel } = await renderPython();
    await waitFor(() => expect(indicator()).toBeTruthy());
    expect(indicator()?.textContent).toBe("Kernel completion: on while the kernel runs");
    const v = await editorView();
    act(() => v.dispatch({ selection: { anchor: 5 } }));
    act(() => void startCompletion(v));
    // The fake kernel answers no_kernel: the editor keeps its own completion and says why.
    await waitFor(() =>
      expect(indicator()?.textContent).toBe("Kernel completion off: the kernel is not started"),
    );
    // The code around the cursor: its line, up to the end.
    expect(kernel.completions).toEqual([{ op: "complete", code: "print(1)", cursor: 5 }]);
  });

  it("a shared reader's read-only view has no kernel completion", async () => {
    const { kernel } = await renderPython({ readOnly: true });
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(indicator()).toBeNull();
    expect(kernel.completions).toEqual([]);
  });

  it("without a conversation it never asks, and says so", async () => {
    const { kernel } = await renderPython({ threadId: null });
    await waitFor(() => expect(indicator()).toBeTruthy());
    expect(indicator()?.textContent).toBe("Kernel completion off: send a message first");
    expect(kernel.completions).toEqual([]);
  });
});
