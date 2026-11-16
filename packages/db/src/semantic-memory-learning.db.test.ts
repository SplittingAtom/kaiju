import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";

/**
 * KOBE-389 (v1.3 Semantic Memory SMB1; SM13, SM15, SM16, SM18, SM22): the Phase B learning tables
 * (passes, candidates, dismissals, watermarks, Workspace proposals). Constraints, keys, the
 * one-active-pass index, thread purge cascades and legal-hold guards; isolation is proven by the
 * cross-team probe (probe.db.test.ts). Raw SQL as the app role inside a team transaction, as
 * withTeam() does.
 */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const teamA = randomUUID();
const teamB = randomUUID();
const owner = randomUUID();
const other = randomUUID();
const requester = randomUUID();
const approver = randomUUID();
const HASH = "a".repeat(64);

const TEAM_TABLES = [
  "memory_learning_passes",
  "memory_candidates",
  "memory_dismissals",
  "memory_learning_watermarks",
  "memory_proposals",
];

/** Runs `fn` as the app role in a team transaction; rolls back unless `commit`. */
async function inTeam<T>(
  teamId: string,
  fn: (c: pg.Client) => Promise<T>,
  commit = false,
): Promise<T> {
  const c = new pg.Client({ connectionString: inject("appUrl") });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamId]);
    const result = await fn(c);
    await c.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    await c.end();
  }
}

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

const one = async (c: pg.Client, sql: string, params: unknown[]): Promise<string> => {
  const { rows } = await c.query<{ id: string }>(sql, params);
  const id = rows[0]?.id;
  if (!id) throw new Error(`no row: ${sql}`);
  return id;
};

/** A thread of `ownerId` in `team` with a branch root → a → b and a side branch root → c. */
async function thread(team: string, ownerId = owner): Promise<string> {
  const id = await one(
    admin,
    `INSERT INTO threads (team_id, owner_user_id, title) VALUES ($1, $2, 'T') RETURNING id`,
    [team, ownerId],
  );
  for (const [entry, parent] of [
    ["root", null],
    ["a", "root"],
    ["b", "a"],
    ["c", "root"],
  ] as const) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type) VALUES ($1, $2, $3, $4, 'message')`,
      [team, id, entry, parent],
    );
  }
  return id;
}

const pass = (
  c: pg.Client,
  team: string,
  threadId: string,
  status = "queued",
  userId = owner,
  extra = "",
) =>
  one(
    c,
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status${extra ? ", finished_at, to_entry_id" : ""})
     VALUES ($1, $2, $3, 'b', 'learner', 'v1', $4${extra}) RETURNING id`,
    [team, threadId, userId, status],
  );

const candidate = (c: pg.Client, team: string, passId: string, ord = 0) =>
  one(
    c,
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload)
     VALUES ($1, $2, $3, '{"statement":"Prefers metric units"}') RETURNING id`,
    [team, passId, ord],
  );

const proposal = (c: pg.Client, team: string, candidateId: string, proposer = owner) =>
  one(
    c,
    `INSERT INTO memory_proposals (team_id, source, candidate_ref, statement, kind, rationale, proposer_id)
     VALUES ($1, 'candidate', $2, 'Deploys go out on Tuesdays', 'convention', 'Said in standup', $3) RETURNING id`,
    [team, candidateId, proposer],
  );

async function hold(team: string, userId: string | null): Promise<string> {
  const id = await one(
    admin,
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [team, userId, requester],
  );
  await admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    approver,
  ]);
  return id;
}

async function release(id: string): Promise<void> {
  await admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
    [id, requester],
  );
  await admin.query(`UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`, [
    id,
    approver,
  ]);
}

beforeAll(async () => {
  await admin.connect();
  for (const [id, name] of [
    [owner, "Ann"],
    [other, "Bo"],
    [requester, "Req"],
    [approver, "App"],
  ] as const) {
    await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${id}@sml.test`,
    ]);
  }
  for (const id of [requester, approver]) {
    await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  }
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
    teamA,
    `sml-${teamA.slice(0, 8)}`,
    teamB,
    `sml-${teamB.slice(0, 8)}`,
  ]);
});

afterAll(() => admin.end());

describe("learning passes (ac-2)", () => {
  it("refuses a second queued or running pass on a thread, across sessions", async () => {
    const t = await thread(teamA);
    const first = await inTeam(teamA, (c) => pass(c, teamA, t), true);
    await inTeam(teamA, async (c) => {
      const again = `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version, status)
                     VALUES ($1, $2, $3, 'b', 'learner', 'v1', $4)`;
      expect(await code(c, again, [teamA, t, owner, "queued"])).toBe("23505");
      expect(await code(c, again, [teamA, t, owner, "running"])).toBe("23505");
      // Another person's pass on the same thread waits too: one pass per thread.
      expect(await code(c, again, [teamA, t, other, "queued"])).toBe("23505");
      // A finished pass does not hold the slot.
      await c.query(
        `UPDATE memory_learning_passes SET status = 'completed', to_entry_id = 'b', finished_at = now() WHERE team_id = $1 AND id = $2`,
        [teamA, first],
      );
      expect(await code(c, again, [teamA, t, owner, "queued"])).toBeUndefined();
    });
  });

  it("holds status, finish, error, usage and entry rules", async () => {
    const t = await thread(teamA);
    await inTeam(teamA, async (c) => {
      const ins = (cols: string, vals: string) =>
        code(
          c,
          `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version${cols})
           VALUES ($1, $2, $3, 'b', 'learner', 'v1'${vals})`,
          [teamA, t, owner],
        );
      expect(await ins(", status", ", 'paused'")).toBe("23514");
      // Finished exactly when completed or failed; a completed pass names its last entry.
      expect(await ins(", status", ", 'completed'")).toBe("23514");
      expect(await ins(", status, finished_at", ", 'running', now()")).toBe("23514");
      expect(await ins(", status, finished_at", ", 'completed', now()")).toBe("23514");
      expect(await ins(", status, finished_at, to_entry_id", ", 'completed', now(), 'b'")).toBe(
        undefined,
      );
      // An error belongs to a failed pass, and a failed pass says why.
      expect(await ins(", status, finished_at", ", 'failed', now()")).toBe("23514");
      expect(await ins(", status, error", ", 'queued', 'boom'")).toBe("23514");
      expect(await ins(", status, finished_at, error", ", 'failed', now(), 'boom'")).toBe(
        undefined,
      );
      expect(await ins(", usage", `, '[1]'`)).toBe("23514");
      expect(await ins(", usage", `, '{"input":10,"output":2}'`)).toBeUndefined();
      await c.query("DELETE FROM memory_learning_passes WHERE team_id = $1", [teamA]);
      // Entries are entries of the pass's thread.
      expect(await ins(", from_entry_id", ", 'nope'")).toBe("23503");
      expect(await ins(", from_entry_id", ", 'a'")).toBeUndefined();
    });
    const u = await thread(teamA);
    await inTeam(teamA, async (c) => {
      expect(
        await code(
          c,
          `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version)
           VALUES ($1, $2, $3, 'zz', 'learner', 'v1')`,
          [teamA, u, owner],
        ),
      ).toBe("23503");
      expect(
        await code(
          c,
          `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version)
           VALUES ($1, $2, $3, 'b', '', 'v1')`,
          [teamA, u, owner],
        ),
      ).toBe("23514");
    });
  });

  it("refuses a pass on another Workspace's thread", async () => {
    const b = await thread(teamB);
    await inTeam(teamA, async (c) => {
      expect(
        await code(
          c,
          `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version)
           VALUES ($1, $2, $3, 'b', 'learner', 'v1')`,
          [teamA, b, owner],
        ),
      ).toBe("23503");
    });
  });
});

describe("candidates (ac-2)", () => {
  it("defaults to open, expiring in 14 days, one per (pass, ord)", async () => {
    const t = await thread(teamA);
    await inTeam(teamA, async (c) => {
      const p = await pass(c, teamA, t);
      const id = await candidate(c, teamA, p);
      const { rows } = await c.query<{ state: string; days: number }>(
        `SELECT state, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
           FROM memory_candidates WHERE team_id = $1 AND id = $2`,
        [teamA, id],
      );
      expect(rows[0]).toEqual({ state: "open", days: 14 });
      const dup = `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, 0, '{}')`;
      expect(await code(c, dup, [teamA, p])).toBe("23505");
      const bad = (cols: string, vals: string) =>
        code(
          c,
          `INSERT INTO memory_candidates (team_id, pass_id, ord, payload${cols}) VALUES ($1, $2, 1, '{}'${vals})`,
          [teamA, p],
        );
      expect(await bad(", state", ", 'kept'")).toBe("23514");
      expect(await bad(", decided_at", ", now()")).toBe("23514");
      expect(await bad(", state", ", 'saved'")).toBe("23514");
      expect(await bad(", state, decided_at", ", 'saved', now()")).toBeUndefined();
      expect(
        await code(
          c,
          `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, -1, '{}')`,
          [teamA, p],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, 5, '"x"')`,
          [teamA, p],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, 6, jsonb_build_object('s', repeat('x', 40000)))`,
          [teamA, p],
        ),
      ).toBe("23514");
    });
  });
});

describe("expiry indexes for sweeps (ac-2)", () => {
  it("indexes open candidates, pending proposals and finished passes by team and time", async () => {
    const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('memory_candidates', 'memory_proposals', 'memory_learning_passes')`,
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? "";
    expect(def("memory_candidates_expiry_idx")).toMatch(
      /\(team_id, expires_at\) WHERE \(state = 'open'::text\)/,
    );
    expect(def("memory_proposals_expiry_idx")).toMatch(
      /\(team_id, expires_at\) WHERE \(state = 'pending'::text\)/,
    );
    expect(def("memory_learning_passes_finished_idx")).toMatch(/\(team_id, finished_at\)/);
    expect(def("memory_learning_passes_active_unique")).toMatch(
      /UNIQUE INDEX .*\(team_id, thread_id\) WHERE \(status = ANY \(ARRAY\['queued'::text, 'running'::text\]\)\)/,
    );
  });
});

describe("dismissals", () => {
  it("are per person, per thread and statement hash", async () => {
    const t = await thread(teamA);
    await inTeam(teamA, async (c) => {
      const ins = `INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash) VALUES ($1, $2, $3, $4)`;
      expect(await code(c, ins, [teamA, t, owner, HASH])).toBeUndefined();
      expect(await code(c, ins, [teamA, t, owner, HASH])).toBe("23505");
      expect(await code(c, ins, [teamA, t, other, HASH])).toBeUndefined();
      expect(await code(c, ins, [teamA, t, owner, "not-a-hash"])).toBe("23514");
      expect(await code(c, ins, [teamA, t, owner, "A".repeat(64)])).toBe("23514");
    });
  });
});

describe("watermarks (ac-4)", () => {
  it("store an entry of the thread, one per person, usable for the ancestor and LCA checks", async () => {
    const t = await thread(teamA);
    await inTeam(teamA, async (c) => {
      const ins = `INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id) VALUES ($1, $2, $3, $4)`;
      expect(await code(c, ins, [teamA, t, owner, "missing"])).toBe("23503");
      expect(await code(c, ins, [teamA, t, owner, "a"])).toBeUndefined();
      expect(await code(c, ins, [teamA, t, owner, "b"])).toBe("23505");
      // The watermark is an ancestor of leaf b (continue) but not of leaf c (rescan from the LCA).
      const ancestors = `WITH RECURSIVE up AS (
          SELECT entry_id, parent_id FROM thread_entries WHERE team_id = $1 AND thread_id = $2 AND entry_id = $3
          UNION ALL
          SELECT e.entry_id, e.parent_id FROM thread_entries e JOIN up ON e.entry_id = up.parent_id
           WHERE e.team_id = $1 AND e.thread_id = $2)
        SELECT EXISTS (SELECT 1 FROM up JOIN memory_learning_watermarks w
          ON w.team_id = $1 AND w.thread_id = $2 AND w.user_id = $4 AND w.entry_id = up.entry_id) AS ok`;
      const isAncestor = async (leaf: string) =>
        (await c.query<{ ok: boolean }>(ancestors, [teamA, t, leaf, owner])).rows[0]?.ok;
      expect(await isAncestor("b")).toBe(true);
      expect(await isAncestor("c")).toBe(false);
    });
  });
});

describe("Workspace proposals", () => {
  it("hold source, state, decision and text rules and expire in 30 days", async () => {
    const t = await thread(teamA);
    await inTeam(teamA, async (c) => {
      const p = await pass(c, teamA, t);
      const cand = await candidate(c, teamA, p);
      const id = await proposal(c, teamA, cand);
      const { rows } = await c.query<{ state: string; days: number }>(
        `SELECT state, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
           FROM memory_proposals WHERE team_id = $1 AND id = $2`,
        [teamA, id],
      );
      expect(rows[0]).toEqual({ state: "pending", days: 30 });
      const ins = (cols: string, vals: string, params: unknown[] = []) =>
        code(
          c,
          `INSERT INTO memory_proposals (team_id, statement, kind, proposer_id${cols})
           VALUES ($1, 'Deploys go out on Tuesdays', 'convention', $2${vals})`,
          [teamA, owner, ...params],
        );
      // One source, named by its kind of ref.
      expect(await ins(", source", ", 'thread'")).toBe("23514");
      expect(
        await ins(", source, candidate_ref, item_ref", ", 'candidate', $3, $4", [
          cand,
          randomUUID(),
        ]),
      ).toBe("23514");
      expect(await ins(", source, item_ref", ", 'candidate', $3", [randomUUID()])).toBe("23514");
      // The refs are keys into this Workspace.
      expect(await ins(", source, candidate_ref", ", 'candidate', $3", [randomUUID()])).toBe(
        "23503",
      );
      expect(await ins(", source, item_ref", ", 'item', $3", [randomUUID()])).toBe("23503");
      // Decided exactly when approved/rejected/expired; approved/rejected name the curator.
      expect(await ins(", source, state", ", 'candidate', 'approved'")).toBe("23514");
      expect(await ins(", source, state, decided_at", ", 'candidate', 'approved', now()")).toBe(
        "23514",
      );
      expect(
        await ins(
          ", source, state, decided_at, decided_by",
          ", 'candidate', 'approved', now(), $3",
          [other],
        ),
      ).toBeUndefined();
      expect(await ins(", source, state, decided_at", ", 'candidate', 'expired', now()")).toBe(
        undefined,
      );
      expect(await ins(", source, reason", ", 'candidate', 'why'")).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO memory_proposals (team_id, source, statement, kind, proposer_id) VALUES ($1, 'candidate', '  ', 'fact', $2)`,
          [teamA, owner],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO memory_proposals (team_id, source, statement, kind, proposer_id) VALUES ($1, 'candidate', repeat('x', 501), 'fact', $2)`,
          [teamA, owner],
        ),
      ).toBe("23514");
      expect(
        await code(
          c,
          `INSERT INTO memory_proposals (team_id, source, statement, kind, proposer_id) VALUES ($1, 'candidate', 'x', 'rumour', $2)`,
          [teamA, owner],
        ),
      ).toBe("23514");
    });
  });

  it("keep their text when the source item goes (ref cleared)", async () => {
    await inTeam(teamA, async (c) => {
      const item = await one(
        c,
        `WITH i AS (INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind)
                    VALUES ($1, 'user', $2, 'fact') RETURNING team_id, id)
         INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_kind, actor_user_id)
         SELECT team_id, id, 1, 'A fact', 'user', $2 FROM i RETURNING item_id AS id`,
        [teamA, owner],
      );
      const id = await one(
        c,
        `INSERT INTO memory_proposals (team_id, source, item_ref, statement, kind, proposer_id)
         VALUES ($1, 'item', $2, 'A fact', 'fact', $3) RETURNING id`,
        [teamA, item, owner],
      );
      await c.query(`DELETE FROM semantic_memory_items WHERE team_id = $1 AND id = $2`, [
        teamA,
        item,
      ]);
      const { rows } = await c.query(
        `SELECT team_id, source, item_ref, statement FROM memory_proposals WHERE team_id = $1 AND id = $2`,
        [teamA, id],
      );
      expect(rows[0]).toEqual({
        team_id: teamA,
        source: "item",
        item_ref: null,
        statement: "A fact",
      });
    });
  });
});

describe("thread purge (ac-3, SM28)", () => {
  it("takes passes, candidates, dismissals and watermarks with the thread; proposals keep their text", async () => {
    const t = await thread(teamA);
    const keep = await thread(teamA);
    const { prop } = await inTeam(
      teamA,
      async (c) => {
        const p = await pass(c, teamA, t);
        const cand = await candidate(c, teamA, p);
        await candidate(c, teamA, await pass(c, teamA, keep), 0);
        await c.query(
          `INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash) VALUES ($1, $2, $3, $4), ($1, $5, $3, $4)`,
          [teamA, t, owner, HASH, keep],
        );
        await c.query(
          `INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id) VALUES ($1, $2, $3, 'b'), ($1, $4, $3, 'b')`,
          [teamA, t, owner, keep],
        );
        return { prop: await proposal(c, teamA, cand) };
      },
      true,
    );
    await inTeam(
      teamA,
      async (c) => {
        await c.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamA, t]);
      },
      true,
    );
    const count = async (table: string, threadId: string) => {
      const { rows } = await admin.query<{ n: number }>(
        table === "memory_candidates"
          ? `SELECT count(*)::int AS n FROM memory_candidates c JOIN memory_learning_passes p
               ON p.team_id = c.team_id AND p.id = c.pass_id WHERE p.thread_id = $1`
          : `SELECT count(*)::int AS n FROM ${table} WHERE thread_id = $1`,
        [threadId],
      );
      return rows[0]?.n;
    };
    for (const table of [
      "memory_learning_passes",
      "memory_candidates",
      "memory_dismissals",
      "memory_learning_watermarks",
    ]) {
      expect(await count(table, t), table).toBe(0);
      expect(await count(table, keep), table).toBe(1);
    }
    const { rows } = await admin.query(
      `SELECT candidate_ref, statement FROM memory_proposals WHERE id = $1`,
      [prop],
    );
    expect(rows[0]).toEqual({ candidate_ref: null, statement: "Deploys go out on Tuesdays" });
    const { rows: orphans } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_candidates WHERE team_id = $1
         AND NOT EXISTS (SELECT 1 FROM memory_learning_passes p WHERE p.team_id = memory_candidates.team_id AND p.id = memory_candidates.pass_id)`,
      [teamA],
    );
    expect(orphans[0]?.n).toBe(0);
  });
});

describe("legal hold", () => {
  it("refuses deleting a held person's passes, candidates and proposals, and truncating the tables", async () => {
    const t = await thread(teamA);
    const ot = await thread(teamA, other);
    const ids = await inTeam(
      teamA,
      async (c) => {
        const p = await pass(c, teamA, t);
        const cand = await candidate(c, teamA, p);
        const op = await pass(c, teamA, ot, "queued", other);
        const ocand = await candidate(c, teamA, op);
        return {
          p,
          cand,
          prop: await proposal(c, teamA, cand),
          op,
          ocand,
          oprop: await proposal(c, teamA, ocand, other),
        };
      },
      true,
    );
    const h = await hold(teamA, owner);
    try {
      await inTeam(teamA, async (c) => {
        const del = (table: string, id: string) =>
          code(c, `DELETE FROM ${table} WHERE team_id = $1 AND id = $2`, [teamA, id]);
        expect(await del("memory_candidates", ids.cand)).toBe(LEGAL_HOLD_SQLSTATE);
        expect(await del("memory_learning_passes", ids.p)).toBe(LEGAL_HOLD_SQLSTATE);
        expect(await del("memory_proposals", ids.prop)).toBe(LEGAL_HOLD_SQLSTATE);
        // The held person's thread is not purged either (the thread guard).
        expect(
          await code(c, `DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamA, t]),
        ).toBe(LEGAL_HOLD_SQLSTATE);
        // Someone else's rows are not covered; a pass delete takes its candidates.
        expect(await del("memory_proposals", ids.oprop)).toBeUndefined();
        expect(await del("memory_learning_passes", ids.op)).toBeUndefined();
      });
      await admin.query("BEGIN");
      try {
        for (const table of TEAM_TABLES) {
          expect(await code(admin, `TRUNCATE ${table} CASCADE`), table).toBe(LEGAL_HOLD_SQLSTATE);
        }
      } finally {
        await admin.query("ROLLBACK");
      }
    } finally {
      await release(h);
    }
    await inTeam(teamA, async (c) => {
      expect(
        await code(c, `DELETE FROM memory_learning_passes WHERE team_id = $1 AND id = $2`, [
          teamA,
          ids.p,
        ]),
      ).toBeUndefined();
      expect(
        await code(c, `DELETE FROM memory_proposals WHERE team_id = $1 AND id = $2`, [
          teamA,
          ids.prop,
        ]),
      ).toBeUndefined();
    });
  });
});
