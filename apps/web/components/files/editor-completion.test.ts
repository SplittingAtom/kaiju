// @vitest-environment happy-dom
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, Text } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { KernelCompletionAnswer } from "../../lib/notebooks/api";
import { KernelCompleter, WINDOW_BEFORE } from "../../lib/notebooks/kernel-completer";
import {
  KERNEL_DEBOUNCE_MS,
  calleeAt,
  completionWindow,
  docTooltipDom,
  kernelCompletion,
  kernelCompletionSource,
  nameAt,
} from "./editor-completion";

/** KOBE-808: the editor side of kernel completion (window, names, the source, the docs DOM). */
const THREAD = "00000000-0000-4000-8000-0000000000bb";

afterEach(() => {
  vi.useRealTimers();
});

function pyState(doc: string, extra: unknown[] = []) {
  const state = EditorState.create({ doc, extensions: [python(), ...(extra as [])] });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  return state;
}

/** "hang": answers only when aborted, as fetch does (a network error). */
type Answer = ApiResult<KernelCompletionAnswer> | "hang";

function completer(answers: Answer[]) {
  const asked: unknown[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const c = new KernelCompleter(
    {
      complete: (_t, body, signal) => {
        asked.push(body);
        signals.push(signal);
        const next = answers.shift() ?? { ok: true, status: 200, data: { status: "no_kernel" } };
        if (next !== "hang") return Promise.resolve(next);
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () =>
            resolve({ ok: false, error: { status: 0, code: "network_error", message: "x" } }),
          ),
        );
      },
    },
    THREAD,
  );
  return { c, asked, signals };
}

const ok = (data: KernelCompletionAnswer): ApiResult<KernelCompletionAnswer> => ({
  ok: true,
  status: 200,
  data,
});

/** Aborts a context as CodeMirror does when a newer query replaces it. */
function abort(ctx: CompletionContext) {
  const c = ctx as unknown as { abortListeners: (() => void)[] | null };
  for (const l of c.abortListeners ?? []) l();
  c.abortListeners = null;
}

describe("completionWindow", () => {
  it("sends whole lines before the cursor up to a cap, and its line to the end", () => {
    const doc = Text.of(["import os", "x = 1", "os.pa  # tail", "after"]);
    const pos = doc.line(3).from + 5;
    expect(completionWindow(doc, pos)).toEqual({
      start: 0,
      code: "import os\nx = 1\nos.pa  # tail",
    });
    const long = Text.of([...Array.from({ length: 2_000 }, (_, i) => `v${i} = ${i}`), "v1"]);
    const w = completionWindow(long, long.length);
    expect(w.code.length).toBeLessThanOrEqual(WINDOW_BEFORE + 20);
    expect(w.code.endsWith("v1")).toBe(true);
    expect(long.lineAt(w.start).from).toBe(w.start);
  });
});

describe("names for documentation", () => {
  it("finds the callee of the call whose arguments hold the cursor", () => {
    const doc = "import pandas as pd\npd.read_csv(path, sep=";
    const state = pyState(doc);
    expect(calleeAt(state, doc.length)?.name).toBe("pd.read_csv");
    const nested = "f(g(1), ";
    expect(calleeAt(pyState(nested), nested.length)?.name).toBe("f");
    const inner = "f(g(1";
    expect(calleeAt(pyState(inner), inner.length)?.name).toBe("g");
    expect(calleeAt(pyState("f(1)"), 4)).toBeNull();
    expect(calleeAt(pyState("x = 1"), 5)).toBeNull();
    // Only dotted names: a call on a call's result has no name to look up.
    expect(calleeAt(pyState("f()(1, "), 7)).toBeNull();
  });

  it("finds the dotted name ending at the word under the pointer", () => {
    const state = pyState("y = pd.read_csv(p)");
    expect(nameAt(state, 9)).toEqual({ name: "pd.read_csv", from: 4, to: 15 });
    expect(nameAt(state, 5)?.name).toBe("pd");
    expect(nameAt(state, 2)).toBeNull();
  });
});

describe("kernelCompletionSource", () => {
  it("after a debounce asks the kernel; its matches rank above built-ins, without duplicates", async () => {
    vi.useFakeTimers();
    const doc = "alpha_one = 1\nalp";
    const { c, asked } = completer([
      ok({
        status: "ok",
        op: "complete",
        matches: [
          { text: "alpha_one", type: "variable" },
          { text: "alpha_two", type: "variable" },
        ],
        cursorStart: 14,
        cursorEnd: 17,
      }),
    ]);
    const source = kernelCompletionSource(c);
    const state = pyState(doc, [kernelCompletion(c)]);
    const pending = source(
      new CompletionContext(state, doc.length, false),
    ) as Promise<CompletionResult | null>;
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(KERNEL_DEBOUNCE_MS);
    const result = await pending;
    expect(asked).toEqual([{ op: "complete", code: doc, cursor: doc.length }]);
    expect(result).toMatchObject({ from: 14, to: 17 });
    // "alpha_one" is the file's own name: the built-in source offers it; the kernel adds the
    // name only it knows (set by an earlier run), ranked above.
    expect(result?.options).toEqual([
      { label: "alpha_two", boost: 50, detail: "kernel", type: "variable" },
    ]);
  });

  it("a keystroke during the debounce cancels the query: nothing is sent", async () => {
    vi.useFakeTimers();
    const { c, asked } = completer([]);
    const state = pyState("df.");
    const ctx = new CompletionContext(state, 3, false);
    const pending = kernelCompletionSource(c)(ctx) as Promise<CompletionResult | null>;
    abort(ctx);
    await vi.advanceTimersByTimeAsync(KERNEL_DEBOUNCE_MS);
    expect(await pending).toBeNull();
    expect(asked).toEqual([]);
  });

  it("a newer query aborts the request in flight", async () => {
    vi.useFakeTimers();
    const { c, signals } = completer(["hang"]);
    const ctx = new CompletionContext(pyState("df."), 3, false);
    const pending = kernelCompletionSource(c)(ctx) as Promise<CompletionResult | null>;
    await vi.advanceTimersByTimeAsync(KERNEL_DEBOUNCE_MS);
    abort(ctx);
    expect(signals[0]?.aborted).toBe(true);
    expect(await pending).toBeNull();
  });

  it("asks only after a name, a dot or a quote unless Ctrl+Space; never while unavailable", async () => {
    vi.useFakeTimers();
    const { c, asked } = completer([]);
    const source = kernelCompletionSource(c);
    expect(await source(new CompletionContext(pyState("x = "), 4, false))).toBeNull();
    expect(asked).toEqual([]);
    c.setRunning(true);
    expect(await source(new CompletionContext(pyState("df."), 3, true))).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("docTooltipDom", () => {
  it("shows the kernel's text as text, never as markup", () => {
    const dom = docTooltipDom({ signature: "f(<b>x</b>)", doc: "<img src=x onerror=alert(1)>" });
    expect(dom.querySelector("img, b")).toBeNull();
    expect(dom.textContent).toBe("f(<b>x</b>)<img src=x onerror=alert(1)>");
    expect(dom.getAttribute("role")).toBe("tooltip");
  });
});
