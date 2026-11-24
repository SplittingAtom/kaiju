import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropIdleTestDatabase,
  listTestDatabaseCandidates,
  selectStaleTestDatabases,
} from "./sweep.js";

// KOBE-743: the listing reads real creation times and sessions; dropping refuses while anyone is
// connected. Other worktrees use this server right now: this file selects (with a future "now")
// but only ever drops its own database.

const base = process.env.KAIJU_TEST_DATABASE_URL ?? "";
const ours = `kaiju_test_${randomBytes(4).toString("hex")}_sweep`;
const DAY = 24 * 60 * 60 * 1000;

describe("stale test database sweep (KOBE-743)", () => {
  const admin = new pg.Client({ connectionString: base });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${ours}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${ours} WITH (FORCE)`);
    await admin.end();
  });

  it("lists a new database with its creation time; it is stale only a day later and when idle", async () => {
    const mine = (await listTestDatabaseCandidates(admin)).find((c) => c.name === ours);
    expect(mine?.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (mine?.createdAt?.getTime() ?? 0))).toBeLessThan(10 * 60_000);
    expect(mine?.connections).toBe(0);
    const only = mine ? [mine] : [];
    expect(selectStaleTestDatabases(only, { now: Date.now() })).toEqual([]);
    expect(selectStaleTestDatabases(only, { now: Date.now() + 2 * DAY })).toEqual([ours]);

    const session = new pg.Client({
      connectionString: Object.assign(new URL(base), { pathname: `/${ours}` }).toString(),
    });
    await session.connect();
    try {
      const busy = (await listTestDatabaseCandidates(admin)).filter((c) => c.name === ours);
      expect(busy[0]?.connections).toBe(1);
      expect(selectStaleTestDatabases(busy, { now: Date.now() + 2 * DAY })).toEqual([]);
      // The drop itself refuses while a session is open (no FORCE).
      expect(await dropIdleTestDatabase(admin, ours)).toBe(false);
    } finally {
      await session.end();
    }
  });

  it("drops the idle database, and refuses names that are not throwaway databases", async () => {
    let dropped = false;
    for (let attempt = 0; attempt < 50 && !dropped; attempt++) {
      // The closed session's backend can take a moment to exit.
      dropped = await dropIdleTestDatabase(admin, ours);
      if (!dropped) await new Promise((r) => setTimeout(r, 100));
    }
    expect(dropped).toBe(true);
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [ours]);
    expect(rowCount).toBe(0);
    await expect(dropIdleTestDatabase(admin, "postgres")).rejects.toThrow(/not a throwaway/);
  });
});
