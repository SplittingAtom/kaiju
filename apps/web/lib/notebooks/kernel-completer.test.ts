import { describe, expect, it } from "vitest";
import type { NotebookCompletionBody } from "@kobe/protocol";
import type { ApiResult } from "../api/client";
import type { KernelCompletionAnswer, NotebookApi } from "./api";
import {
  KERNEL_BACKOFF_MS,
  KernelCompleter,
  codePoints,
  utf16Offset,
  type KernelCompletionState,
} from "./kernel-completer";

/** KOBE-808: the editor's kernel completion client (gating, cancellation, mapping, states). */
const THREAD = "00000000-0000-4000-8000-0000000000bb";

type Answer = ApiResult<KernelCompletionAnswer> | Promise<ApiResult<KernelCompletionAnswer>>;

function fake(answers: Answer[] = []) {
  const calls: { body: NotebookCompletionBody; signal: AbortSignal | undefined }[] = [];
  const api: Pick<NotebookApi, "complete"> = {
    complete: (_thread, body, signal) => {
      calls.push({ body, signal });
      return Promise.resolve(answers.shift() ?? ok({ status: "no_kernel" }));
    },
  };
  return { api, calls };
}

const ok = (data: KernelCompletionAnswer): ApiResult<KernelCompletionAnswer> => ({
  ok: true,
  status: 200,
  data,
});
const matches = (
  cursorStart: number,
  cursorEnd: number,
  ...texts: string[]
): ApiResult<KernelCompletionAnswer> =>
  ok({
    status: "ok",
    op: "complete",
    matches: texts.map((text) => ({ text, type: "attribute" })),
    cursorStart,
    cursorEnd,
  });

describe("code points (Jupyter counts the cursor in them)", () => {
  it("counts a surrogate pair as one and maps back to UTF-16", () => {
    expect(codePoints("a😀b")).toBe(3);
    expect(utf16Offset("a😀b", 2)).toBe(3);
    expect(utf16Offset("a😀b", 9)).toBe(4);
    expect(codePoints("")).toBe(0);
  });
});

describe("KernelCompleter (KOBE-808)", () => {
  it("sends the cursor in code points and maps the answer's span back to UTF-16", async () => {
    const { api, calls } = fake([matches(4, 6, "alpha", "align")]);
    const c = new KernelCompleter(api, THREAD);
    const code = "😀df.al";
    const got = await c.complete(code, code.length);
    expect(calls[0]?.body).toEqual({ op: "complete", code, cursor: 6 });
    expect(got).toEqual({
      from: 5,
      to: 7,
      matches: [
        { label: "alpha", type: "attribute" },
        { label: "align", type: "attribute" },
      ],
    });
    expect(c.state).toBe("ready");
  });

  it("drops a span that starts after the cursor", async () => {
    const { api } = fake([matches(9, 9, "x")]);
    expect(await new KernelCompleter(api, THREAD).complete("ab", 2)).toBeNull();
  });

  it("asks for a dotted name's docs only, never code", async () => {
    const doc: KernelCompletionAnswer = {
      status: "ok",
      op: "doc",
      found: true,
      signature: "head(n=5)",
      doc: "First rows.",
    };
    const { api, calls } = fake([ok(doc), ok({ status: "ok", op: "doc", found: false })]);
    const c = new KernelCompleter(api, THREAD);
    expect(await c.doc("df.head")).toEqual({ signature: "head(n=5)", doc: "First rows." });
    expect(await c.doc("nothing")).toBeNull();
    expect(await c.doc("os.system('x')")).toBeNull();
    expect(calls.map((x) => x.body)).toEqual([
      { op: "doc", name: "df.head" },
      { op: "doc", name: "nothing" },
    ]);
  });

  it.each([
    ["no_kernel", "no_kernel"],
    ["asleep", "asleep"],
    ["busy", "busy"],
    ["unavailable", "unavailable"],
  ] as const)("%s: says why, sends nothing for a while, then asks again", async (status, state) => {
    let now = 1_000;
    const { api, calls } = fake([ok({ status }), matches(0, 1, "x1")]);
    const c = new KernelCompleter(api, THREAD, () => now);
    const seen: KernelCompletionState[] = [];
    c.subscribe(() => seen.push(c.state));
    expect(await c.complete("x", 1)).toBeNull();
    expect(c.state).toBe(state);
    expect(seen).toEqual([state]);
    expect(await c.complete("x", 1)).toBeNull();
    expect(calls).toHaveLength(1);
    now += KERNEL_BACKOFF_MS[state] ?? 0;
    expect(await c.complete("x", 1)).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(c.state).toBe("ready");
  });

  it("an older sandbox agent: off for good, never asked again", async () => {
    let now = 0;
    const { api, calls } = fake([ok({ status: "unsupported" })]);
    const c = new KernelCompleter(api, THREAD, () => now);
    await c.complete("x", 1);
    expect(c.state).toBe("unsupported");
    now += 3_600_000;
    c.kernelChanged();
    c.setRunning(false);
    expect(c.available()).toBe(false);
    await c.complete("x", 1);
    expect(calls).toHaveLength(1);
  });

  it("429: paused as rate limited; other errors: unavailable for a while", async () => {
    const { api } = fake([
      { ok: false, error: { status: 429, code: "rate_limited", message: "slow down" } },
      { ok: false, error: { status: 503, code: "isolation_unavailable", message: "x" } },
    ]);
    let now = 0;
    const c = new KernelCompleter(api, THREAD, () => now);
    expect(await c.complete("x", 1)).toBeNull();
    expect(c.state).toBe("rate_limited");
    expect(c.available()).toBe(false);
    now += KERNEL_BACKOFF_MS.rate_limited ?? 0;
    expect(await c.complete("x", 1)).toBeNull();
    expect(c.state).toBe("unavailable");
  });

  it("a request cancelled by the next keystroke is aborted and changes nothing", async () => {
    let release: (a: ApiResult<KernelCompletionAnswer>) => void = () => undefined;
    const { api, calls } = fake([
      new Promise<ApiResult<KernelCompletionAnswer>>((r) => (release = r)),
    ]);
    const c = new KernelCompleter(api, THREAD);
    const keystroke = new AbortController();
    const pending = c.complete("x", 1, keystroke.signal);
    keystroke.abort();
    expect(calls[0]?.signal?.aborted).toBe(true);
    release({ ok: false, error: { status: 0, code: "network_error", message: "aborted" } });
    expect(await pending).toBeNull();
    expect(c.state).toBe("idle");
    expect(c.available()).toBe(true);
  });

  it("while code runs it is busy and sends nothing; the run's end asks again at once", async () => {
    const { api, calls } = fake([matches(0, 1, "x1")]);
    const c = new KernelCompleter(api, THREAD);
    c.setRunning(true);
    expect(c.state).toBe("busy");
    expect(await c.complete("x", 1)).toBeNull();
    expect(calls).toHaveLength(0);
    c.setRunning(false);
    expect(c.state).toBe("idle");
    expect(await c.complete("x", 1)).not.toBeNull();
  });

  it("a kernel started from the tab ends a no_kernel pause", async () => {
    const { api, calls } = fake([ok({ status: "no_kernel" }), matches(0, 1, "x1")]);
    const c = new KernelCompleter(api, THREAD);
    await c.complete("x", 1);
    expect(c.available()).toBe(false);
    c.kernelChanged();
    expect(c.state).toBe("idle");
    expect(await c.complete("x", 1)).not.toBeNull();
    expect(c.state).toBe("ready");
    expect(calls).toHaveLength(2);
  });

  it("without a conversation it never asks", async () => {
    const { api, calls } = fake();
    const c = new KernelCompleter(api, null);
    expect(c.state).toBe("no_thread");
    expect(await c.complete("x", 1)).toBeNull();
    expect(await c.doc("x")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never sends more than the server takes", async () => {
    const { api, calls } = fake();
    const c = new KernelCompleter(api, THREAD);
    expect(await c.complete("é".repeat(20_000), 1)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("one request in flight: a newer one cancels the older, which changes nothing", async () => {
    const pending: ((a: ApiResult<KernelCompletionAnswer>) => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const c = new KernelCompleter(
      {
        complete: (_t, _b, signal) => {
          signals.push(signal);
          return new Promise((resolve) => pending.push(resolve));
        },
      },
      THREAD,
    );
    const older = c.complete("x", 1);
    const newer = c.doc("x");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    pending[0]?.({ ok: false, error: { status: 0, code: "network_error", message: "aborted" } });
    expect(await older).toBeNull();
    expect(c.state).toBe("idle");
    pending[1]?.(ok({ status: "ok", op: "doc", found: true, signature: "x()" }));
    expect(await newer).toEqual({ signature: "x()", doc: undefined, type: undefined });
  });

  it("never sends a lone surrogate (the server would refuse it)", async () => {
    const { api, calls } = fake();
    expect(await new KernelCompleter(api, THREAD).complete("a\uD800", 1)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
