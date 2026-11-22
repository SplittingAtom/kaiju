// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { must } from "../../lib/testing/must";
import { sha256Hex } from "../../lib/files/editor";
import { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { TooltipProvider } from "../ui/tooltip";
import PythonFile, { SAVE_FIRST_NOTE } from "./python-run";
import { NO_THREAD_NOTE } from "./kernel-bar";
import { ev, execId, Kernel, runId, THREAD, Workspace } from "./testing";

/** KOBE-465 ac-3, KOBE-615 ac-7/ac-8: a `.py` file's Run in the toolbar and the output split. */
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const PATH = "src/job.py";

async function setup(
  drafts = new EditDraftStore(),
  threadId: string | null = THREAD,
  readOnly = false,
) {
  const kernel = new Kernel();
  const workspace = new Workspace(PATH, "print(1)\n");
  const sha = await sha256Hex(new TextEncoder().encode(workspace.text));
  render(
    <TooltipProvider>
      <PythonFile
        path={PATH}
        text={workspace.text}
        sha256={sha}
        truncated={false}
        api={workspace.api}
        drafts={drafts}
        reviews={new FileReviewStore()}
        onSaved={() => {}}
        onReload={() => {}}
        kernel={kernel.wiring(threadId, readOnly)}
      />
    </TooltipProvider>,
  );
  return kernel;
}

const toolbar = () => screen.getByRole("toolbar", { name: "job.py view" });

function finish(kernel: Kernel) {
  act(() =>
    kernel.store.apply(THREAD, [
      ev(runId(1), "notebook.output", {
        exec_id: execId(1),
        index: 0,
        output: { output_type: "stream", name: "stdout", text: "hello\n" },
      }),
      ev(runId(1), "notebook.output", {
        exec_id: execId(1),
        index: 1,
        output: { output_type: "error", ename: "KeyError", evalue: "'k'", traceback: [] },
      }),
      ev(runId(1), "notebook.finished", {
        exec_id: execId(1),
        status: "error",
        execution_count: 3,
        outputs: 2,
        truncated: false,
        saved: null,
      }),
    ]),
  );
}

describe("Run for .py files (ac-7, ac-8)", () => {
  it("Run is in the toolbar; a run splits the editor and shows its outputs live", async () => {
    const kernel = await setup();
    const user = userEvent.setup();
    expect(screen.queryByRole("region", { name: "Run output" })).toBeNull();
    for (const name of ["Run", "Interrupt", "Start", "Save", "Save As"]) {
      expect(within(toolbar()).getByRole("button", { name })).toBeTruthy();
    }
    await user.click(within(toolbar()).getByRole("button", { name: "Run" }));
    await waitFor(() => expect(kernel.runs).toEqual([{ path: PATH }]));
    const pane = screen.getByRole("region", { name: "Run output" });
    expect(await within(pane).findByText("Running…")).toBeTruthy();
    // Code on top, the output below, with a divider between them.
    const split = pane.closest("[data-kobe-split]") as HTMLElement;
    expect(split.querySelector("[data-kobe-split-top] [data-kobe-editor-body]")).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize the code and its output" })).toBeTruthy();
    finish(kernel);
    expect(await within(pane).findByText("KeyError: 'k'")).toBeTruthy();
    expect(within(pane).getByText("hello")).toBeTruthy();
    expect(within(pane).queryByText("Running…")).toBeNull();
    // A .py run is never saved anywhere: no "not saved" note.
    expect(within(pane).queryByText(/not saved/u)).toBeNull();
    // The kernel's state sits in the toolbar; Restart takes Start's place once it ran.
    expect(within(toolbar()).getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(toolbar().querySelector("[data-kobe-kernel]")).toBeTruthy();
  });

  it("the output stays after the run, collapses, and closes back to the full height", async () => {
    const kernel = await setup();
    const user = userEvent.setup();
    await user.click(within(toolbar()).getByRole("button", { name: "Run" }));
    finish(kernel);
    const pane = await screen.findByRole("region", { name: "Run output" });
    await user.click(within(pane).getByRole("button", { name: "Collapse the output" }));
    expect(screen.queryByRole("separator", { name: "Resize the code and its output" })).toBeNull();
    expect(within(pane).queryByText("hello")).toBeNull();
    await user.click(within(pane).getByRole("button", { name: "Expand the output" }));
    expect(within(pane).getByText("hello")).toBeTruthy();
    await user.click(within(pane).getByRole("button", { name: "Close the output" }));
    expect(screen.queryByRole("region", { name: "Run output" })).toBeNull();
    // The next run opens it again.
    await user.click(within(toolbar()).getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("region", { name: "Run output" })).toBeTruthy();
  });

  it("the divider resizes from the keyboard and is remembered per viewer", async () => {
    const kernel = await setup();
    const user = userEvent.setup();
    await user.click(within(toolbar()).getByRole("button", { name: "Run" }));
    finish(kernel);
    const divider = await screen.findByRole("separator", {
      name: "Resize the code and its output",
    });
    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    expect(divider.getAttribute("aria-valuenow")).toBe("50");
    act(() => divider.focus());
    await user.keyboard("{ArrowDown}");
    expect(localStorage.getItem("kobe.fileEditor.split")).toBe("55");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(localStorage.getItem("kobe.fileEditor.split")).toBe("45");
    await user.keyboard("{End}");
    expect(localStorage.getItem("kobe.fileEditor.split")).toBe("85");
    await user.keyboard("{Enter}");
    expect(localStorage.getItem("kobe.fileEditor.split")).toBeNull();
  });

  it("has no Run or kernel controls for a shared reader", async () => {
    await setup(undefined, THREAD, true);
    for (const name of ["Run", "Interrupt", "Restart", "Start"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("does not run unsaved changes", async () => {
    const drafts = new EditDraftStore();
    drafts.set(PATH, { text: "print(2)", baseSha256: "a".repeat(64) });
    await setup(drafts);
    const run = within(toolbar()).getByRole("button", { name: "Run" });
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(run.getAttribute("title")).toBe(SAVE_FIRST_NOTE);
    expect(screen.getByRole("note").textContent).toBe(SAVE_FIRST_NOTE);
  });

  it("needs a conversation: disabled with the reason; the agent's runs show in the split", async () => {
    const kernel = await setup(undefined, null);
    for (const name of ["Run", "Interrupt", "Start"]) {
      const button = within(toolbar()).getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("title")).toBe(NO_THREAD_NOTE);
    }
    cleanup();
    const k2 = await setup();
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

describe("Python opens in Raw (KOBE-802)", () => {
  const editor = () => document.querySelector("[data-kobe-code-editor]");

  it("opens in the code editor; an explicit switch to Rendered is kept when it reopens", async () => {
    const drafts = new EditDraftStore();
    await setup(drafts);
    const user = userEvent.setup();
    await waitFor(() => expect(editor()).toBeTruthy());
    const mode = screen.getByRole("switch", { name: "Raw" });
    expect(mode.getAttribute("aria-checked")).toBe("true");
    await user.click(mode);
    expect(editor()).toBeNull();
    cleanup(); // the tab closes and reopens in the same session
    await setup(drafts);
    expect(screen.getByRole("switch", { name: "Raw" }).getAttribute("aria-checked")).toBe("false");
    expect(editor()).toBeNull();
  });

  it("does not take the cursor unless the member opened the tab (an agent's open leaves focus)", async () => {
    await setup();
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(editor()?.contains(document.activeElement)).toBe(false);
  });

  it("a read-only file opens in Raw, read-only, with the reason", async () => {
    await setup(new EditDraftStore(), THREAD, true);
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Raw" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("kernel completion in a .py file (KOBE-808)", () => {
  const indicator = () => document.querySelector("[data-kobe-kernel-completion]");
  const editor = () => document.querySelector("[data-kobe-code-editor]");

  it("the owner's editor completes from the conversation's kernel and says when it is off", async () => {
    const kernel = await setup();
    await waitFor(() => expect(indicator()).toBeTruthy());
    expect(indicator()?.textContent).toBe("Kernel completion: on while the kernel runs");
    const view = EditorView.findFromDOM(must(document.querySelector<HTMLElement>(".cm-editor")));
    const v = must(view);
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
    const kernel = await setup(new EditDraftStore(), THREAD, true);
    await waitFor(() => expect(editor()).toBeTruthy());
    expect(indicator()).toBeNull();
    expect(kernel.completions).toEqual([]);
  });

  it("without a conversation it never asks, and says so", async () => {
    const kernel = await setup(new EditDraftStore(), null);
    await waitFor(() => expect(indicator()).toBeTruthy());
    expect(indicator()?.textContent).toBe("Kernel completion off: send a message first");
    expect(kernel.completions).toEqual([]);
  });
});
