import { describe, expect, it, vi } from "vitest";
import type { ListenSession } from "../pg-listen.js";
import { SessionLeaderLock } from "./leader-lock.js";

const KEY = 42;
const HOLDER = { pid: 1234, started: "2026-11-21 10:00:00+00", app: "kobe-server-listen" };

/** A fake LISTEN session answering the lock's queries from `state`. */
function fakeSession(state: {
  lockFree: boolean;
  pid?: number;
  /** Rows the stale-holder lookup finds (pid, backend_start and application_name all match). */
  staleAlive?: boolean;
  terminateError?: Error & { code?: string };
}) {
  const queries: string[] = [];
  const session: ListenSession = {
    active: true,
    query: vi.fn(<R>(text: string) => {
      queries.push(text);
      if (text.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ ok: state.lockFree }] as R[] });
      }
      if (text.includes("pg_terminate_backend")) {
        if (state.terminateError) return Promise.reject(state.terminateError);
        return Promise.resolve({ rows: (state.staleAlive ? [{ ok: true }] : []) as R[] });
      }
      if (text.includes("pg_backend_pid")) {
        const pid = state.pid ?? HOLDER.pid;
        return Promise.resolve({
          rows: [{ pid, started: HOLDER.started, app: HOLDER.app }] as R[],
        });
      }
      return Promise.resolve({ rows: [] as R[] });
    }) as ListenSession["query"],
  };
  return { session, queries };
}

const log = () => ({ warn: vi.fn(), info: vi.fn() });

describe("SessionLeaderLock (KOBE-704 review)", () => {
  it("acquires a free lock and records its own backend", async () => {
    const lock = new SessionLeaderLock(KEY, log());
    const { session, queries } = fakeSession({ lockFree: true });
    expect(await lock.tryAcquire(session)).toBe("acquired");
    expect(lock.holder).toEqual(HOLDER);
    expect(queries.some((q) => q.includes("pg_backend_pid"))).toBe(true);
  });

  it("is busy, and terminates nothing, when it never held the lock", async () => {
    const lock = new SessionLeaderLock(KEY, log());
    const { session, queries } = fakeSession({ lockFree: false, staleAlive: true });
    expect(await lock.tryAcquire(session)).toBe("busy");
    expect(queries.some((q) => q.includes("pg_terminate_backend"))).toBe(false);
  });

  it("after losing its connection, ends its own stale backend once and asks to retry", async () => {
    const l = log();
    const lock = new SessionLeaderLock(KEY, l);
    await lock.tryAcquire(fakeSession({ lockFree: true }).session);
    lock.lost();
    const next = fakeSession({ lockFree: false, staleAlive: true, pid: 999 });
    expect(await lock.tryAcquire(next.session)).toBe("reclaimed");
    const terminate = (next.session.query as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("pg_terminate_backend"),
    );
    // pid, backend_start and application_name must all still match (pid reuse, another replica).
    expect(String(terminate?.[0])).toMatch(/backend_start/);
    expect(String(terminate?.[0])).toMatch(/application_name/);
    expect(terminate?.[1]).toEqual([HOLDER.pid, HOLDER.started, HOLDER.app]);
    expect(l.warn).toHaveBeenCalled();
    // Done once: the next busy answer does not terminate again.
    expect(await lock.tryAcquire(next.session)).toBe("busy");
    expect(next.queries.filter((q) => q.includes("pg_terminate_backend"))).toHaveLength(1);
  });

  it("leaves a lock held by anyone else alone (the stale backend is gone)", async () => {
    const lock = new SessionLeaderLock(KEY, log());
    await lock.tryAcquire(fakeSession({ lockFree: true }).session);
    lock.lost();
    const next = fakeSession({ lockFree: false, staleAlive: false });
    expect(await lock.tryAcquire(next.session)).toBe("busy");
  });

  it("logs clearly and gives up reclaiming when the role may not terminate backends", async () => {
    const l = log();
    const lock = new SessionLeaderLock(KEY, l);
    await lock.tryAcquire(fakeSession({ lockFree: true }).session);
    lock.lost();
    const denied = Object.assign(new Error("must be a member of the role"), { code: "42501" });
    const next = fakeSession({ lockFree: false, terminateError: denied });
    expect(await lock.tryAcquire(next.session)).toBe("busy");
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: denied }),
      expect.stringMatching(/may not end its old backend/),
    );
  });

  it("forgets the holder on release", async () => {
    const lock = new SessionLeaderLock(KEY, log());
    const { session, queries } = fakeSession({ lockFree: true });
    await lock.tryAcquire(session);
    await lock.release(session);
    expect(lock.holder).toBeUndefined();
    expect(queries.some((q) => q.includes("pg_advisory_unlock"))).toBe(true);
  });
});
