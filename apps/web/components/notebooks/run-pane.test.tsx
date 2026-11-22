// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { VariablesResult } from "../../lib/notebooks/variables";
import { LOG_EMPTY } from "./run-log-panel";
import { CLEARED_NOTE, OUTPUT_EMPTY } from "./run-output-panel";
import { RUN_TAB_KEY } from "./run-pane";
import type { Kernel } from "./testing";
import { ev, execId, renderPython, runId, THREAD } from "./testing";
import {
  NOT_RUNNING,
  PAUSED_NOTE,
  READER_NOTE,
  STALE_NOTE,
  TOO_OLD,
  VARIABLES_EMPTY,
} from "./variables-panel";

/** KOBE-804: the `.py` run pane's Run Output, Log and Variables tabs. */
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const PATH = "src/job.py";
const toolbar = () => screen.getByRole("toolbar", { name: "job.py view" });
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const panel = (id: string) =>
  document.querySelector<HTMLElement>(`[data-kobe-run-panel="${id}"]`) as HTMLElement;

const ok = (data: VariablesResult): ApiResult<VariablesResult> => ({ ok: true, status: 200, data });
const SNAPSHOT: VariablesResult = {
  status: "ok",
  takenAt: "2026-11-22T10:00:00Z",
  executionCount: 2,
  truncated: false,
  variables: [
    { name: "x", type: "int", repr: "42" },
    { name: "html", type: "str", repr: "'<b>bold</b><img src=x onerror=alert(1)>'", len: 38 },
    {
      name: "df",
      type: "DataFrame",
      module: "pandas",
      repr: "",
      shape: [3, 2],
      columns: [
        { name: "a", dtype: "int64" },
        { name: "b", dtype: "object" },
      ],
      columnsTotal: 2,
    },
    { name: "API_TOKEN", type: "str", repr: "'sk-secret'", len: 11 },
    { name: "slow", type: "Slow", module: "__main__", repr: "", reprError: "timeout" },
  ],
  other: [{ name: "np", kind: "module" }],
};

function started(kernel: Kernel, n: number, origin: "user" | "agent" = "user") {
  act(() =>
    kernel.store.apply(THREAD, [
      ev(runId(n), "notebook.started", {
        exec_id: execId(n),
        origin,
        path: PATH,
        ...(origin === "agent" ? { tool_call_id: `t${n}` } : {}),
      }),
    ]),
  );
}

function finished(kernel: Kernel, n: number, status: "ok" | "error", text: string) {
  act(() =>
    kernel.store.apply(THREAD, [
      ev(runId(n), "notebook.output", {
        exec_id: execId(n),
        index: 0,
        output: { output_type: "stream", name: "stdout", text: `${text}\n` },
      }),
      ev(runId(n), "notebook.finished", {
        exec_id: execId(n),
        status,
        execution_count: n,
        outputs: 1,
        truncated: false,
        saved: null,
        timing: {
          started_at: "2026-11-22T10:00:00Z",
          finished_at: "2026-11-22T10:00:00.25Z",
          duration_ms: 250,
        },
        ...(status === "error" ? { error: { name: "ValueError", line: 1 } } : {}),
      }),
    ]),
  );
}

async function openPane() {
  const user = userEvent.setup();
  await user.click(within(toolbar()).getByRole("button", { name: "Show run pane" }));
  return user;
}

describe("the run pane's tabs (ac-1)", () => {
  it("three tabs with roving focus, arrow keys, Home and End; panels stay mounted", async () => {
    await renderPython();
    const user = await openPane();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Run Output", "Log", "Variables"]);
    expect(screen.getByRole("tablist", { name: "Run output, log and variables" })).toBeTruthy();
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    for (const t of tabs) {
      const p = document.getElementById(t.getAttribute("aria-controls") ?? "");
      expect(p?.getAttribute("role")).toBe("tabpanel");
      expect(p?.getAttribute("aria-labelledby")).toBe(t.id);
    }
    act(() => tabs[0]?.focus());
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(panel("log").hidden).toBe(false);
    expect(panel("output").hidden).toBe(true);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[2]);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[0]);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabs[2]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("remembers the chosen tab for the member", async () => {
    await renderPython();
    const user = await openPane();
    await user.click(tab(/^Log/u));
    expect(localStorage.getItem(RUN_TAB_KEY)).toBe("log");
    cleanup();
    await renderPython();
    await openPane();
    expect(tab(/^Log/u).getAttribute("aria-selected")).toBe("true");
  });

  it("explains each tab before any run (ac-4)", async () => {
    await renderPython();
    await openPane();
    expect(within(panel("output")).getByText(OUTPUT_EMPTY)).toBeTruthy();
    expect(within(panel("log")).getByText(LOG_EMPTY)).toBeTruthy();
  });
});

describe("Run Output and Log (ac-2)", () => {
  it("lists runs newest first with who, status and duration; a chosen run shows its output", async () => {
    const { kernel } = await renderPython();
    started(kernel, 1);
    finished(kernel, 1, "error", "first");
    started(kernel, 2, "agent");
    finished(kernel, 2, "ok", "second");
    const user = userEvent.setup();
    expect(within(panel("output")).getByText("second")).toBeTruthy();
    await user.click(tab(/^Log/u));
    const entries = [...panel("log").querySelectorAll("[data-kobe-log-entry]")];
    expect(entries.map((e) => e.getAttribute("data-kobe-log-entry"))).toEqual([
      execId(2),
      execId(1),
    ]);
    expect(entries[0]?.textContent).toMatch(/Agent · Done · 250 ms · \[2\]/u);
    expect(entries[1]?.textContent).toMatch(/You · Error · 250 ms · \[1\]/u);
    expect(within(entries[1] as HTMLElement).getByText("ValueError on line 1")).toBeTruthy();
    await user.click(within(entries[1] as HTMLElement).getByTitle("Show this run's output"));
    expect(tab(/^Run Output/u).getAttribute("aria-selected")).toBe("true");
    expect(within(panel("output")).getByText("first")).toBeTruthy();
    expect(within(panel("output")).getByText(/^Earlier run:/u)).toBeTruthy();
    await user.click(within(panel("output")).getByRole("button", { name: "Show the latest run" }));
    expect(within(panel("output")).getByText("second")).toBeTruthy();
    // A newer run is shown again, whatever was chosen.
    await user.click(tab(/^Log/u));
    await user.click(within(entries[1] as HTMLElement).getByTitle("Show this run's output"));
    started(kernel, 3);
    expect(within(panel("output")).queryByText("first")).toBeNull();
  });

  it("Clear empties the tab until the next run", async () => {
    const { kernel } = await renderPython();
    started(kernel, 1);
    finished(kernel, 1, "ok", "first");
    const user = userEvent.setup();
    await user.click(within(panel("output")).getByRole("button", { name: "Clear" }));
    expect(within(panel("output")).getByText(CLEARED_NOTE)).toBeTruthy();
    started(kernel, 2);
    finished(kernel, 2, "ok", "again");
    expect(within(panel("output")).getByText("again")).toBeTruthy();
  });

  it("marks a tab with new output or a failed run while another tab is chosen", async () => {
    const { kernel } = await renderPython();
    started(kernel, 1);
    const user = userEvent.setup();
    await user.click(tab(/^Variables/u));
    finished(kernel, 1, "error", "boom");
    expect(tab(/^Run Output/u).textContent).toBe("Run Output, new output");
    expect(tab(/^Log/u).textContent).toBe("Log, a run failed");
    expect(tab(/^Variables/u).querySelector("[data-kobe-badge]")).toBeNull();
    await user.click(tab(/^Run Output/u));
    expect(tab(/^Run Output/u).querySelector("[data-kobe-badge]")).toBeNull();
    expect(tab(/^Log/u).querySelector("[data-kobe-badge]")).toBeTruthy();
    await user.click(tab(/^Log/u));
    expect(tab(/^Log/u).querySelector("[data-kobe-badge]")).toBeNull();
  });
});

describe("Variables (ac-3, ac-4)", () => {
  it("shows name, type and value with summaries, as text; hides credential-like values", async () => {
    const { kernel } = await renderPython();
    kernel.variableAnswers.push(ok(SNAPSHOT));
    const user = await openPane();
    await user.click(tab(/^Variables/u));
    const table = await within(panel("variables")).findByRole("table", { name: "Variables" });
    expect(kernel.variableCalls).toEqual([false]);
    const row = (name: string) =>
      table.querySelector<HTMLElement>(`[data-kobe-variable="${name}"]`) as HTMLElement;
    expect(row("x").textContent).toContain("int");
    expect(row("x").textContent).toContain("42");
    expect(row("df").textContent).toContain("pandas.DataFrame");
    expect(row("df").textContent).toContain("3 rows × 2 columns");
    expect(row("slow").textContent).toContain("took too long");
    // HTML in a repr is text, never markup.
    expect(row("html").textContent).toContain("<b>bold</b>");
    expect(row("html").querySelector("b, img")).toBeNull();
    expect(row("html").textContent).toContain("len 38");
    // A credential-like name's value stays hidden until shown.
    expect(row("API_TOKEN").textContent).not.toContain("sk-secret");
    await user.click(
      within(row("API_TOKEN")).getByRole("button", { name: "Show the value of API_TOKEN" }),
    );
    expect(row("API_TOKEN").textContent).toContain("sk-secret");
    expect(
      within(panel("variables")).getByText(/Also defined \(names only\): np \(module\)/u),
    ).toBeTruthy();
    // Sorted by name, both ways; filtered by name.
    const names = () =>
      [...table.querySelectorAll("[data-kobe-variable]")].map((r) =>
        r.getAttribute("data-kobe-variable"),
      );
    expect(names()).toEqual(["API_TOKEN", "df", "html", "slow", "x"]);
    const sort = within(table).getByRole("button", { name: /^Name/u });
    await user.click(sort);
    expect(sort.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(names()).toEqual(["x", "slow", "html", "df", "API_TOKEN"]);
    await user.type(within(panel("variables")).getByLabelText("Filter variables by name"), "D");
    expect(names()).toEqual(["df"]);
    // A row expands to the longer value and a DataFrame's columns.
    const expand = within(row("df")).getByRole("button", { name: /df/u });
    await user.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(panel("variables")).getByText(/Columns: a \(int64\), b \(object\)/u),
    ).toBeTruthy();
    // The filter and open rows stay while another tab is chosen.
    await user.click(tab(/^Log/u));
    await user.click(tab(/^Variables/u));
    expect(names()).toEqual(["df"]);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
  });

  it("is stale while code runs, asks again after the run, and Refresh asks for a fresh one", async () => {
    const { kernel } = await renderPython();
    kernel.variableAnswers.push(ok(SNAPSHOT), ok({ ...SNAPSHOT, variables: [] }), ok(SNAPSHOT));
    const user = await openPane();
    await user.click(tab(/^Variables/u));
    await within(panel("variables")).findByRole("table", { name: "Variables" });
    started(kernel, 1);
    expect(within(panel("variables")).getByText(STALE_NOTE)).toBeTruthy();
    const refresh = within(panel("variables")).getByRole("button", { name: "Refresh" });
    expect(refresh.hasAttribute("disabled")).toBe(true);
    expect(kernel.variableCalls).toEqual([false]);
    finished(kernel, 1, "ok", "done");
    await waitFor(() => expect(kernel.variableCalls).toEqual([false, false]));
    expect(
      await within(panel("variables")).findByText(
        "No variables yet: your code has not defined any.",
      ),
    ).toBeTruthy();
    await user.click(refresh);
    await waitFor(() => expect(kernel.variableCalls).toEqual([false, false, true]));
    expect(
      await within(panel("variables")).findByRole("table", { name: "Variables" }),
    ).toBeTruthy();
  });

  it("says when the kernel is not running, the agent is too old, or snapshots are paused", async () => {
    const { kernel } = await renderPython();
    kernel.variableAnswers.push(ok({ status: "no_kernel" }), {
      ok: false,
      error: { status: 409, code: "variables_unsupported", message: "old" },
    });
    const user = await openPane();
    await user.click(tab(/^Variables/u));
    expect(await within(panel("variables")).findByText(NOT_RUNNING)).toBeTruthy();
    await user.click(within(panel("variables")).getByRole("button", { name: "Refresh" }));
    expect(await within(panel("variables")).findByText(TOO_OLD)).toBeTruthy();
    cleanup();
    const second = await renderPython();
    second.kernel.variableAnswers.push(
      ok({ ...SNAPSHOT, autoPaused: "snapshot_timeout", truncated: true }),
    );
    const user2 = await openPane();
    await user2.click(tab(/^Variables/u));
    expect(
      await within(panel("variables")).findByText(new RegExp(PAUSED_NOTE.slice(0, 30), "u")),
    ).toBeTruthy();
    expect(within(panel("variables")).getByText(/Some variables are left out/u)).toBeTruthy();
  });

  it("explains itself before the first answer, and a shared reader never asks", async () => {
    const { kernel } = await renderPython();
    let answer: (r: ApiResult<VariablesResult>) => void = () => {};
    kernel.variableAnswers.push(new Promise((r) => (answer = r)));
    const user = await openPane();
    await user.click(tab(/^Variables/u));
    expect(within(panel("variables")).getByText("Reading the variables…")).toBeTruthy();
    await act(async () => answer(ok({ status: "unavailable" })));
    expect(within(panel("variables")).getByText(/did not answer in time/u)).toBeTruthy();
    expect(VARIABLES_EMPTY).toMatch(/Variables shows/u);
    cleanup();
    const reader = await renderPython({ readOnly: true });
    started(reader.kernel, 1, "agent");
    await userEvent.setup().click(tab(/^Variables/u));
    expect(within(panel("variables")).getByText(READER_NOTE)).toBeTruthy();
    expect(reader.kernel.variableCalls).toEqual([]);
  });
});
