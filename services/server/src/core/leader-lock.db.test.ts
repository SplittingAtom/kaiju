import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionLeaderLock } from "../models/leader-lock.js";
import type { ListenSession } from "../pg-listen.js";
import { openHarness, type Harness } from "../testing/harness.js";

// KOBE-704 review: a replica whose LISTEN connection went half-open keeps the leader lock on its
// old backend; on its new connection it ends that backend (same role) and leads again.

const KEY = 0x6b6f_6265_7e57;
const APP = "kaiju-test-leader-listen";

let h: Harness;
const clients: pg.Client[] = [];
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => {
  for (const c of clients) await c.end().catch(() => undefined);
  await h.close();
});

async function connect(app = APP): Promise<{ client: pg.Client; session: ListenSession }> {
  const client = new pg.Client({ connectionString: h.appUrl, application_name: app });
  client.on("error", () => undefined); // the terminated one reports its FATAL here
  await client.connect();
  clients.push(client);
  const session: ListenSession = {
    active: true,
    query: <R>(text: string, values?: unknown[]) =>
      client.query(text, values) as unknown as Promise<{ rows: R[] }>,
  };
  return { client, session };
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("leader lock reclaim (KOBE-704 review)", () => {
  it("ends this replica's own stale backend as the app role and takes the lock again", async () => {
    const log = { warn: vi.fn() };
    const lock = new SessionLeaderLock(KEY, log);
    const old = await connect();
    expect(await lock.tryAcquire(old.session)).toBe("acquired");
    const oldPid = lock.holder?.pid;
    // The connection is lost from this side only: the old backend lives on, holding the lock.
    lock.lost();
    const fresh = await connect();
    expect(await lock.tryAcquire(fresh.session)).toBe("reclaimed");
    await waitFor(async () => (await lock.tryAcquire(fresh.session)) === "acquired");
    const { rows } = await h.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1",
      [oldPid],
    );
    expect(rows[0]?.n).toBe(0);
    await lock.release(fresh.session);
  });

  it("never ends another replica's healthy leader", async () => {
    const other = await connect("kaiju-test-other-replica");
    const otherLock = new SessionLeaderLock(KEY, { warn: vi.fn() });
    const mine = new SessionLeaderLock(KEY, { warn: vi.fn() });
    const old = await connect();
    expect(await mine.tryAcquire(old.session)).toBe("acquired");
    // This replica's old backend really ends; another replica takes over.
    await old.client.end();
    mine.lost();
    await waitFor(async () => (await otherLock.tryAcquire(other.session)) === "acquired");
    const fresh = await connect();
    expect(await mine.tryAcquire(fresh.session)).toBe("busy");
    const { rows } = await other.client.query<{ ok: number }>("SELECT 1 AS ok");
    expect(rows[0]?.ok).toBe(1);
    await otherLock.release(other.session);
  });
});
