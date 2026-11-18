import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

/**
 * KOBE-402 (v1.3 Semantic Memory SMC1; SM19, SM20): `site_memory_proposals`, a Workspace's
 * proposal of a statement for the Site. A site-wide table (no team_id, no RLS) read only through
 * server paths; `from_team_id` is a column, not the tenancy key. Constraints, keys and grants here;
 * the catalog checks (catalog.db.test.ts) classify it as site-wide and team-referencing.
 */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const app = new pg.Client({ connectionString: inject("appUrl") });
const teamA = randomUUID();
const teamGone = randomUUID();
const proposer = randomUUID();
const teamAdmin = randomUUID();
const siteAdmin = randomUUID();

/** The SQLSTATE `sql` fails with, in a savepoint (undefined when it succeeds). */
async function code(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  await c.query("SAVEPOINT probe");
  try {
    await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT probe");
    return undefined;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT probe");
    return (err as { code?: string }).code;
  }
}

/** Runs `fn` as the app role in a transaction (no team set: a Site path); rolls back. */
async function asApp<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await app.query("BEGIN");
  try {
    return await fn(app);
  } finally {
    await app.query("ROLLBACK");
  }
}

const INSERT = `INSERT INTO site_memory_proposals (from_team_id, statement, kind, justification, proposer_id)
  VALUES ($1, $2, $3, $4, $5) RETURNING id`;

async function propose(c: pg.Client, team = teamA): Promise<string> {
  const { rows } = await c.query<{ id: string }>(INSERT, [
    team,
    "Invoices are numbered per year",
    "convention",
    "Finance and Sales both asked this week",
    proposer,
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error("no proposal");
  return id;
}

/** A Site item with its first version, in the caller's transaction. */
async function siteItem(c: pg.Client): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `WITH i AS (INSERT INTO site_memory_items (kind) VALUES ('convention') RETURNING id)
     INSERT INTO site_memory_item_versions (item_id, version, statement, actor_kind, actor_user_id)
     SELECT id, 1, 'Invoices are numbered per year', 'user', $1 FROM i RETURNING item_id AS id`,
    [siteAdmin],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no site item");
  return id;
}

beforeAll(async () => {
  await admin.connect();
  await app.connect();
  for (const [id, name] of [
    [proposer, "Pro"],
    [teamAdmin, "Tad"],
    [siteAdmin, "Sad"],
  ] as const) {
    await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${id}@smp.test`,
    ]);
  }
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'G')`, [
    teamA,
    `smp-${teamA.slice(0, 8)}`,
    teamGone,
    `smp-${teamGone.slice(0, 8)}`,
  ]);
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

describe("site_memory_proposals (ac-1)", () => {
  it("default to awaiting_team, round 0, not endorsed, expiring in 30 days", async () => {
    await asApp(async (c) => {
      const id = await propose(c);
      const { rows } = await c.query<{
        state: string;
        rounds: number;
        endorsed: boolean;
        days: number;
      }>(
        `SELECT state, rounds, endorsed,
                round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
         FROM site_memory_proposals WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ state: "awaiting_team", rounds: 0, endorsed: false, days: 30 });
    });
  });

  it("refuse unknown states and rounds outside 0..3", async () => {
    await asApp(async (c) => {
      const id = await propose(c);
      const set = (fields: string, params: unknown[] = []) =>
        code(c, `UPDATE site_memory_proposals SET ${fields} WHERE id = $1`, [id, ...params]);
      expect(await set(`state = 'pending'`)).toBe("23514");
      expect(await set(`rounds = 4`)).toBe("23514");
      expect(await set(`rounds = -1`)).toBe("23514");
      expect(await set(`rounds = 3`)).toBeUndefined();
      for (const state of ["withdrawn", "expired"]) {
        expect(await set(`state = $2`, [state]), state).toBeUndefined();
      }
    });
  });

  it("hold statement, kind, justification and reason limits", async () => {
    await asApp(async (c) => {
      const ins = (statement: string, kind: string, justification: string) =>
        code(c, INSERT, [teamA, statement, kind, justification, proposer]);
      expect(await ins("  ", "fact", "why")).toBe("23514");
      expect(await ins("x".repeat(501), "fact", "why")).toBe("23514");
      expect(await ins("ok", "policy", "why")).toBe("23514");
      expect(await ins("ok", "fact", " ")).toBe("23514");
      expect(await ins("ok", "fact", "j".repeat(1001))).toBe("23514");
      expect(await ins("ok", "fact", "j".repeat(1000))).toBeUndefined();
      const id = await propose(c);
      const reason = (text: string) =>
        code(c, `UPDATE site_memory_proposals SET reason = $2 WHERE id = $1`, [id, text]);
      expect(await reason("r".repeat(1001))).toBe("23514");
      expect(await reason("")).toBe("23514");
      expect(await reason("Too specific to Finance")).toBeUndefined();
    });
  });

  it("need the Team admin's confirmation past the team, and a decider for a decision", async () => {
    await asApp(async (c) => {
      const id = await propose(c);
      const set = (fields: string, params: unknown[] = []) =>
        code(c, `UPDATE site_memory_proposals SET ${fields} WHERE id = $1`, [id, ...params]);
      for (const state of ["awaiting_site", "approved", "merged"]) {
        expect(await set(`state = $2`, [state]), state).toBe("23514");
      }
      expect(await set(`state = 'rejected'`)).toBe("23514");
      expect(await set(`state = 'changes_requested'`)).toBe("23514");
      expect(
        await set(`state = 'awaiting_site', team_confirmed_by = $2, endorsed = true`, [teamAdmin]),
      ).toBeUndefined();
      expect(await set(`state = 'approved'`)).toBe("23514");
      expect(
        await set(`state = 'approved', decided_by = $2, decided_at = now()`, [siteAdmin]),
      ).toBe(undefined);
    });
  });

  it("name a merged Site item only when merged; a purge of that item clears the link", async () => {
    await asApp(async (c) => {
      const item = await siteItem(c);
      const id = await propose(c);
      const set = (fields: string, params: unknown[] = []) =>
        code(c, `UPDATE site_memory_proposals SET ${fields} WHERE id = $1`, [id, ...params]);
      expect(await set(`merged_into = $2`, [item])).toBe("23514");
      expect(
        await set(
          `state = 'merged', team_confirmed_by = $2, decided_by = $3, decided_at = now(), merged_into = $4`,
          [teamAdmin, siteAdmin, item],
        ),
      ).toBeUndefined();
      expect(await set(`merged_into = $2`, [randomUUID()])).toBe("23503");
      await c.query(`DELETE FROM site_memory_items WHERE id = $1`, [item]);
      const { rows } = await c.query<{ merged_into: string | null; state: string }>(
        `SELECT merged_into, state FROM site_memory_proposals WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ merged_into: null, state: "merged" });
    });
  });

  it("refuse unknown teams and people", async () => {
    await asApp(async (c) => {
      expect(await code(c, INSERT, [randomUUID(), "ok", "fact", "why", proposer])).toBe("23503");
      expect(await code(c, INSERT, [teamA, "ok", "fact", "why", randomUUID()])).toBe("23503");
    });
  });

  it("go with their Workspace; people are deactivated, never deleted (NO ACTION)", async () => {
    const id = await propose(admin, teamGone);
    await admin.query("BEGIN");
    try {
      expect(await code(admin, `DELETE FROM users WHERE id = $1`, [proposer])).toBe("23503");
    } finally {
      await admin.query("ROLLBACK");
    }
    await admin.query(`DELETE FROM teams WHERE id = $1`, [teamGone]);
    const { rows } = await admin.query(`SELECT 1 FROM site_memory_proposals WHERE id = $1`, [id]);
    expect(rows).toEqual([]);
  });

  it("give the app role SELECT, INSERT and UPDATE only, with no RLS", async () => {
    const { rows } = await admin.query<{ rls: boolean }>(
      `SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.site_memory_proposals'::regclass`,
    );
    expect(rows[0]?.rls).toBe(false);
    await asApp(async (c) => {
      const id = await propose(c);
      expect(await code(c, `DELETE FROM site_memory_proposals WHERE id = $1`, [id])).toBe("42501");
      expect(await code(c, `TRUNCATE site_memory_proposals`)).toBe("42501");
    });
  });

  it("index the Site queue, a Workspace's queue, a proposer's list and the expiry sweep", async () => {
    const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'site_memory_proposals'`,
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef;
    expect(def("site_memory_proposals_queue_idx")).toContain("(state, created_at)");
    expect(def("site_memory_proposals_team_idx")).toContain("(from_team_id, state, created_at)");
    expect(def("site_memory_proposals_proposer_idx")).toContain("(proposer_id, created_at)");
    expect(def("site_memory_proposals_expiry_idx")).toMatch(/\(expires_at\) WHERE/);
    expect(def("site_memory_proposals_merged_idx")).toContain("(merged_into)");
  });
});

describe("site_memory_proposals carry no team content (ac-2)", () => {
  // SM19/SM20: only a statement and a justification cross the wall. Evidence, quotes, rationale,
  // thread or entry links and run references never reach the Site.
  const FORBIDDEN = /evidence|rationale|quote|thread|entry|entries|(^|_)runs?(_|$)/;

  it("has no evidence, rationale, quote, thread, entry or run column", async () => {
    const { rows } = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'site_memory_proposals'`,
    );
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.map((r) => r.column_name).filter((n) => FORBIDDEN.test(n))).toEqual([]);
  });

  it("the pattern catches the names it guards against", () => {
    for (const name of [
      "evidence",
      "rationale",
      "quotes",
      "thread_id",
      "source_entry_id",
      "entries",
      "run_id",
    ]) {
      expect(FORBIDDEN.test(name), name).toBe(true);
    }
    expect(FORBIDDEN.test("rounds")).toBe(false);
  });

  it("is referenced by no team table and has no foreign key to one", async () => {
    const { rows } = await admin.query<{ other: string }>(
      `SELECT CASE WHEN conrelid = 'public.site_memory_proposals'::regclass
                   THEN confrelid::regclass::text ELSE conrelid::regclass::text END AS other
       FROM pg_constraint
       WHERE contype = 'f' AND 'public.site_memory_proposals'::regclass IN (conrelid, confrelid)`,
    );
    expect(rows.map((r) => r.other).sort()).toEqual([
      "site_memory_items",
      "teams",
      "users",
      "users",
      "users",
    ]);
  });
});
