import type { IsolationProbe } from "../runs/seams.js";

/** An isolation probe whose answer a test sets (KOBE-708); production passes the gate's status. */
export interface FakeIsolation {
  readonly probe: IsolationProbe;
  set(state: ReturnType<IsolationProbe>): void;
}

/** A fake isolation check, `available` until a test says otherwise. Tests only. */
export function fakeIsolation(initial: ReturnType<IsolationProbe> = "available"): FakeIsolation {
  let state = initial;
  return {
    probe: () => state,
    set(next) {
      state = next;
    },
  };
}
