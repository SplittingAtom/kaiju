import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { RetentionJob, purgeThreads } from "./index.js";
import {
  h,
  objects,
  PREFIX,
  blobs,
  log,
  ids,
  as,
  team,
  other,
  ago,
  thread,
  endedRun,
  key,
  named,
  forkLinks,
  threadIds,
  audits,
  pass,
  setPeriod,
  useRetentionHarness,
} from "./retention.test-helpers.js";

useRetentionHarness();

describe("the nightly pass (D18)", () => {
  it("purges exactly the expired threads and their blobs; shared objects and other teams survive", async () => {
    await setPeriod(team, "90d");
    const old = await thread({
      owner: ids.bob,
      activity: ago(100),
      blobKeys: [key("old-1"), key("shared")],
    });
    // A fork of the old thread shares its object (dedup): the object must survive the purge.
    const fresh = await thread({
      owner: ids.bob,
      activity: ago(10),
      blobKeys: [key("fresh"), named("shared")],
    });
    await thread({
      owner: ids.carol,
      activity: ago(40),
      deletedAt: ago(31),
      blobKeys: [key("trash-1")],
    });
    const trashedRecently = await thread({
      owner: ids.carol,
      activity: ago(40),
      deletedAt: ago(10),
    });
    // An old thread with a queued run is skipped (the next pass retries).
    const busy = await thread({ owner: ids.bob, activity: ago(200) });
    await h.admin.query(
      `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos) VALUES ($1, $2, 'user', 'queued', 1)`,
      [team, busy],
    );
    // Another team: forever (default), same age: untouched.
    const elsewhere = await thread({ teamId: other, owner: ids.bob, activity: ago(400) });

    const result = await pass();

    expect(await threadIds()).toEqual([fresh, trashedRecently, busy].sort());
    expect(await threadIds(other)).toEqual([elsewhere]);
    expect(objects.deleted.sort()).toEqual([named("old-1"), named("trash-1")].sort());
    expect(objects.keys().sort()).toEqual([named("fresh"), named("shared")].sort());
    const mine = result.teams.find((t) => t.teamId === team);
    expect(mine).toMatchObject({
      trash: { threads: 1, entries: 2, blobs: 1 },
      retention: { threads: 1, entries: 2, blobs: 2 },
      blobs: { blobs: 2, kept: 1 },
      failed: false,
    });
    // Audited as counts only, by the system.
    const purged = (await audits("retention.purged")).slice(-2);
    expect(purged.map((a) => a.target)).toEqual([
      { reason: "trash", threads: 1, entries: 2, runs: 0, events: 0, blobs: 1 },
      { reason: "retention", threads: 1, entries: 2, runs: 0, events: 0, blobs: 2 },
    ]);
    expect(purged.every((a) => a.actor_kind === "system" && a.actor_id === null)).toBe(true);
    expect((await audits("retention.blobs_deleted")).at(-1)?.target).toEqual({ blobs: 2, kept: 1 });
    expect(old).not.toBe(fresh);
    // Nothing left to do: a second pass purges and audits nothing.
    const before = (await audits("retention.purged")).length;
    await pass();
    expect((await audits("retention.purged")).length).toBe(before);
  });

  it("purges a fork's source, never the fork: the link clears, team and fork point stay (KOBE-215)", async () => {
    await setPeriod(team, "90d");
    const expired = await thread({ owner: ids.bob, activity: ago(100) });
    const trashed = await thread({ owner: ids.carol, activity: ago(40), deletedAt: ago(31) });
    const forks = [
      await thread({ owner: ids.bob, forkOf: expired }),
      await thread({ owner: ids.carol, forkOf: trashed }),
    ];

    const result = await pass();

    expect(await threadIds()).toEqual([...forks].sort());
    const cleared = { team_id: team, forked_from_thread_id: null, forked_at_entry_id: "e1" };
    expect(await forkLinks()).toEqual([cleared, cleared]);
    expect(result.teams.find((t) => t.teamId === team)).toMatchObject({
      trash: { threads: 1 },
      retention: { threads: 1 },
      failed: false,
    });
  });

  it("purges archived and pinned threads by their activity like any other (CE19, KOBE-220)", async () => {
    await setPeriod(team, "90d");
    const archivedOld = await thread({ owner: ids.bob, activity: ago(100) });
    const pinnedOld = await thread({ owner: ids.bob, activity: ago(100) });
    const archivedRecent = await thread({ owner: ids.carol, activity: ago(10) });
    // Archiving or pinning never counts as activity: the period runs from the last message.
    await h.admin.query(
      `UPDATE threads SET archived_at = now() WHERE team_id = $1 AND id = ANY($2::uuid[])`,
      [team, [archivedOld, archivedRecent]],
    );
    await h.admin.query(`UPDATE threads SET pinned_at = now() WHERE team_id = $1 AND id = $2`, [
      team,
      pinnedOld,
    ]);

    const result = await pass();

    expect(await threadIds()).toEqual([archivedRecent]);
    expect(result.teams.find((t) => t.teamId === team)).toMatchObject({
      retention: { threads: 2 },
      failed: false,
    });
  });

  it("deletes only keys in the purged thread's own tree, never anything a crafted reference names", async () => {
    await setPeriod(team, "30d");
    const victim = await thread({ owner: ids.carol, blobKeys: [key("victim")] });
    const foreign = `${PREFIX}teams/${other}/uploads/x`;
    const workspace = `${PREFIX}teams/${team}/users/${ids.bob}/workspace/${"b".repeat(64)}`;
    const upload = `${PREFIX}teams/${team}/uploads/carols-file`;
    const outside = `elsewhere/${team}/x`;
    const crafted = [foreign, workspace, upload, outside];
    for (const k of crafted) objects.objects.set(k, Buffer.from("x"));
    // Bob's thread points at Carol's thread's object and at objects outside any thread tree.
    await thread({
      owner: ids.bob,
      activity: ago(40),
      blobKeys: [named("victim"), ...crafted],
      entries: 5,
    });
    await h.admin.query(
      `UPDATE thread_entries SET blob_ref = NULL WHERE team_id = $1 AND thread_id = $2`,
      [team, victim],
    );
    await pass();
    expect(objects.deleted).toEqual([]);
    expect(objects.keys().sort()).toEqual([...crafted, named("victim")].sort());
    // Bob's thread went; Carol's stays (recent activity).
    expect(await threadIds()).toEqual([victim]);
  });

  it("re-reads the period in every batch: a lengthening mid-pass stops the purge", async () => {
    await setPeriod(team, "30d");
    for (let i = 0; i < 3; i++) await thread({ owner: ids.bob, activity: ago(40 + i) });
    let batches = 0;
    const outcome = await purgeThreads(
      h.deps.database.db,
      team,
      { kind: "retention" },
      async () => {
        batches += 1;
        // An admin lengthens the period while the first batch runs (committed before the next).
        if (batches === 1) await setPeriod(team, "1y");
      },
      { limits: { threads: 1, entries: 1000 } },
    );
    expect(outcome.counts.threads).toBe(1);
    expect(await threadIds()).toHaveLength(2);
  });

  it("keeps Trash its full 30 days and restarts the period on restore (review H1)", async () => {
    await setPeriod(team, "30d");
    // Idle 25 days when trashed, 6 days ago: past the period now, but Trash keeps it 30 days.
    const trashed = await thread({ owner: ids.bob, activity: ago(31), deletedAt: ago(6) });
    // Idle 29 days and in Trash: restored, it must not be purged at the next pass.
    const restored = await thread({ owner: ids.bob, activity: ago(29), deletedAt: ago(1) });
    expect((await as.bob.post(`/v1/threads/${restored}/restore`)).status).toBe(200);
    // Simulate the next nights: two days later the restored thread is still well inside 30 days.
    await h.admin.query(
      `UPDATE threads SET last_activity_at = last_activity_at - interval '2 days'
        WHERE team_id = $1 AND id = $2`,
      [team, restored],
    );
    await pass();
    expect(await threadIds()).toEqual([trashed, restored].sort());
  });

  it("compacts run events 7 days after the run ended, keeping the entries", async () => {
    const t = await thread({ owner: ids.bob });
    const due = await endedRun(t, 8);
    const recent = await endedRun(t, 6);
    const r = await pass();
    expect(r.teams.find((x) => x.teamId === team)?.compacted).toEqual({ runs: 1, events: 3 });
    const { rows } = await h.admin.query<{ id: string; events: number; compacted: boolean }>(
      `SELECT r.id, (SELECT count(*)::int FROM run_events e WHERE e.team_id = r.team_id AND e.run_id = r.id) AS events,
              r.events_compacted_at IS NOT NULL AS compacted
         FROM runs r WHERE r.team_id = $1 ORDER BY r.ended_at`,
      [team],
    );
    expect(rows).toEqual([
      { id: due, events: 0, compacted: true },
      { id: recent, events: 3, compacted: false },
    ]);
    expect(
      (
        await h.admin.query(`SELECT 1 FROM thread_entries WHERE team_id = $1 AND thread_id = $2`, [
          team,
          t,
        ])
      ).rowCount,
    ).toBe(2);
    expect((await audits("retention.compacted")).at(-1)?.target).toEqual({ runs: 1, events: 3 });
    // The stream of a compacted run answers 410 (KOBE-31 contract).
    const stream = await as.bob.get(`/v1/runs/${due}/events`);
    expect(stream.status).toBe(410);
  });
});

describe("one replica at a time, once a day", () => {
  it("lets one replica run a pass while another holds the lock; skips when not due", async () => {
    const job = (now?: Date, pool: { connect: () => Promise<PoolClient> } = h.deps.database.pool) =>
      new RetentionJob({
        db: h.deps.database.db,
        pool,
        blobs,
        hourUtc: 3,
        logger: log,
        ...(now ? { now: () => now } : {}),
      });
    const holder = await h.deps.database.pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended('kobe.retention', 0))");
      expect(await job().tick(true)).toBe("busy");
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('kobe.retention', 0))");
      holder.release();
    }
    const at = new Date("2026-10-04T03:10:00Z");
    expect(await job(at).tick()).toBe("ran");
    // The same night again, and the next day outside the hour: not due.
    expect(await job(new Date("2026-10-04T03:40:00Z")).tick()).toBe("not_due");
    expect(await job(new Date("2026-10-05T12:00:00Z")).tick()).toBe("not_due");
    expect(await job(new Date("2026-10-05T03:05:00Z")).tick()).toBe("ran");
    // Two concurrent ticks: exactly one runs. The first is held right after it takes the lock, so
    // the second tries while the first still holds it (KOBE-247: two ticks started together let
    // the first finish its pass before the second tried, and both ran).
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taken = () => {};
    const lockTaken = new Promise<void>((resolve) => (taken = resolve));
    const held = {
      connect: async () => {
        const client = await h.deps.database.pool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          if (String(args[0]).includes("pg_try_advisory_lock")) {
            // Once: the client goes back to the pool unwrapped.
            delete (client as unknown as { query?: unknown }).query;
            taken();
            await gate;
          }
          return result;
        };
        return client;
      },
    };
    const first = job(undefined, held).tick(true);
    await Promise.race([
      lockTaken,
      first.then((r) => Promise.reject(new Error(`first tick ended before the lock: ${r}`))),
    ]);
    expect(await job().tick(true)).toBe("busy");
    release();
    expect(await first).toBe("ran");
  });
});

describe("pass interruptions (review M3, L2, L6)", () => {
  const job = (pool: { connect: () => Promise<PoolClient> }, now?: Date) =>
    new RetentionJob({
      db: h.deps.database.db,
      pool,
      blobs,
      hourUtc: 3,
      logger: log,
      ...(now ? { now: () => now } : {}),
    });

  it("stops the pass when the lock connection fails, without crashing, and resumes on the next check", async () => {
    await setPeriod(team, "30d");
    const old = await thread({ owner: ids.bob, activity: ago(40) });
    let lockClient: PoolClient | undefined;
    const failing = {
      connect: async () => {
        const client = await h.deps.database.pool.connect();
        lockClient = client;
        // The connection drops right after the lock is taken (failover, idle kill).
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          const result = await query(...args);
          if (String(args[0]).includes("pg_try_advisory_lock")) {
            client.emit("error", new Error("terminating connection due to administrator command"));
          }
          return result;
        };
        return client;
      },
    };
    expect(await job(failing).tick(true)).toBe("lost");
    expect(lockClient).toBeDefined();
    // Nothing was purged and the pass stays open: the next check resumes it, even outside the hour.
    expect(await threadIds()).toEqual([old]);
    const cursor = await h.admin.query<{ value: string }>(
      `SELECT value FROM site_settings WHERE key = 'retention.cursor'`,
    );
    expect(cursor.rows[0]?.value).toBe("start");
    // The job closed the failed connection (release(true)), but pg ends it without waiting: its
    // backend, which still holds the session lock, can outlive tick() by a few ms. A real failed
    // connection is already gone; wait for this one's backend to exit (KOBE-674).
    const pid = (lockClient as unknown as { processID: number }).processID;
    await vi.waitFor(
      async () => {
        const live = await h.admin.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1`, [pid]);
        expect(live.rowCount).toBe(0);
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(await job(h.deps.database.pool, new Date("2026-10-05T12:00:00Z")).tick()).toBe("ran");
    expect(await threadIds()).toEqual([]);
  });

  it("resumes an unfinished pass after the last team done, not from the start", async () => {
    await setPeriod(team, "30d");
    await setPeriod(other, "30d");
    const first = team < other ? team : other;
    const second = team < other ? other : team;
    const a = await thread({ teamId: first, owner: ids.bob, activity: ago(40) });
    const b = await thread({ teamId: second, owner: ids.bob, activity: ago(40) });
    // A pass crashed after finishing `first` (whose thread then came back, e.g. a restore).
    await h.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('retention.cursor', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [first],
    );
    expect(await job(h.deps.database.pool, new Date("2026-10-05T12:00:00Z")).tick()).toBe("ran");
    expect(await threadIds(first)).toEqual([a]);
    expect(await threadIds(second)).toEqual([]);
    expect(b).toBeTruthy();
    const settings = await h.admin.query<{ key: string; value: string }>(
      `SELECT key, value FROM site_settings WHERE key IN ('retention.cursor', 'retention.last_pass_at')`,
    );
    expect(Object.fromEntries(settings.rows.map((r) => [r.key, r.value]))).toMatchObject({
      "retention.cursor": "",
      "retention.last_pass_at": expect.any(String),
    });
  });
});
