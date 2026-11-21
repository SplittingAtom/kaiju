import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// CI runs every package's tests at once (turbo, --maxWorkers=3), so a render can take several
// times longer than on an idle machine. findBy*/waitFor get 5 s instead of 1 s; one slow render
// should not fail a test. Tests that need a longer wait still pass their own timeout.
configure({ asyncUtilTimeout: 5_000 });

// next/font/local only works inside Next's compiler (KOBE-555, app/faces.ts): tests that import
// the root layout get a face whose class is its variable name (app/faces.test.ts reads the source).
vi.mock("next/font/local", () => ({
  default: (options: { readonly variable: string }) => ({
    className: options.variable,
    variable: options.variable,
    style: { fontFamily: `var(${options.variable})` },
  }),
}));

// KOBE-744: no browser timer outlives its test. A component's timer still pending when a file's
// DOM is torn down fires into a missing `window` (a Radix HoverCard open/close timer from the
// rail's thread card, `components/shell/rail-thread-card.tsx`, failed a CI run that way). After
// each test the tree is unmounted and every `window.setTimeout` the test left pending is cleared.
// Errors are not hidden: a timer that throws during its test still fails it.
if (typeof window !== "undefined") {
  type TimerId = ReturnType<typeof window.setTimeout>;
  type Callback = (...args: unknown[]) => void;
  const pending = new Set<TimerId>();
  const set = window.setTimeout.bind(window) as (
    h: Callback,
    ms?: number,
    ...a: unknown[]
  ) => TimerId;
  const clear = window.clearTimeout.bind(window) as (id?: TimerId) => void;
  const tracked = (handler: TimerHandler, timeout?: number, ...args: unknown[]): TimerId => {
    if (typeof handler !== "function") return set(() => undefined, timeout);
    const id = set(
      (...a: unknown[]) => {
        pending.delete(id);
        (handler as Callback)(...a);
      },
      timeout,
      ...args,
    );
    pending.add(id);
    return id;
  };
  window.setTimeout = tracked as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id?: TimerId) => {
    if (id !== undefined) pending.delete(id);
    clear(id);
  }) as typeof window.clearTimeout;
  afterEach(() => {
    cleanup();
    for (const id of pending) clear(id);
    pending.clear();
  });
}
