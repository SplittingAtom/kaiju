import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";

/**
 * KOBE-652 (v1.3 Semantic Memory SMB14; SM7, SM22, Q2): readers' suggestions for a project's
 * Notes. Constraints, keys, cascades with the thread and project, the candidate ref and the
 * legal-hold guards; isolation is proven by the cross-team probe (probe.db.test.ts). Raw SQL as the
 * app role inside a team transaction, as withTeam() does.
 */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const teamA = randomUUID();
const teamB = randomUUID();
const reader = randomUUID();
const editor = randomUUID();
const requester = randomUUID();
const approver = randomUUID();
const EVIDENCE = JSON.stringify([{ entryId: "a", quote: "we number invoices per year" }]);

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

const project = (team: string) =>
  one(
    admin,
    `INSERT INTO projects (team_id, slug, name, created_by) VALUES ($1, $2, 'P', $3) RETURNING id`,
    [team, `p-${randomUUID().slice(0, 8)}`, editor],
  );

/** A project thread of `ownerId` with one entry `a`. */
async function thread(team: string, projectId: string, ownerId = reader): Promise<string> {
  const id = await one(
    admin,
    `INSERT INTO threads (team_id, owner_user_id, title, project_id) VALUES ($1, $2, 'T', $3) RETURNING id`,
    [team, ownerId, projectId],
  );
  await admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, type) VALUES ($1, $2, 'a', 'message')`,
    [team, id],
  );
  return id;
}

/** An open candidate of a pass by `userId` over the thread. */
async function candidate(c: pg.Client, team: string, threadId: string, userId = reader) {
  const passId = await one(
    c,
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id, model_alias, prompt_version)
     VALUES ($1, $2, $3, 'a', 'learner', 'v1') RETURNING id`,
    [team, threadId, userId],
  );
  return one(
    c,
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload)
     VALUES ($1, $2, 0, '{"statement":"Invoices are numbered per year"}') RETURNING id`,
    [team, passId],
  );
}

const INSERT = `INSERT INTO memory_project_suggestions
  (team_id, project_id, thread_id, candidate_ref, statement, kind, evidence, suggested_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`;

const suggest = (
  c: pg.Client,
  team: string,
  projectId: string,
  threadId: string,
  candidateRef: string | null = null,
  by = reader,
) =>
  one(c, INSERT, [
    team,
    projectId,
    threadId,
    candidateRef,
    "Invoices are numbered per year",
    "convention",
    EVIDENCE,
    by,
  ]);

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
    [reader, "Rea"],
    [editor, "Ed"],
    [requester, "Req"],
    [approver, "App"],
  ] as const) {
    await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      name,
      `${id}@mps.test`,
    ]);
  }
  for (const id of [requester, approver]) {
    await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  }
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
    teamA,
    `mps-${teamA.slice(0, 8)}`,
    teamB,
    `mps-${teamB.slice(0, 8)}`,
  ]);
});

afterAll(() => admin.end());

describe("suggestions", () => {
  it("default to pending, expiring in 30 days, and hold text, kind and evidence rules", async () => {
    const p = await project(teamA);
    const t = await thread(teamA, p);
    await inTeam(teamA, async (c) => {
      const id = await suggest(c, teamA, p, t);
      const { rows } = await c.query<{ state: string; days: number }>(
        `SELECT state, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
           FROM memory_project_suggestions WHERE team_id = $1 AND id = $2`,
        [teamA, id],
      );
      expect(rows[0]).toEqual({ state: "pending", days: 30 });
      const bad = (statement: string, kind: string, evidence: string) =>
        code(c, INSERT, [teamA, p, t, null, statement, kind, evidence, reader]);
      expect(await bad("  ", "convention", EVIDENCE)).toBe("23514");
      expect(await bad("x".repeat(501), "convention", EVIDENCE)).toBe("23514");
      expect(await bad("x".repeat(500), "convention", EVIDENCE)).toBeUndefined();
      expect(await bad("ok", "rumour", EVIDENCE)).toBe("23514");
      // Evidence: a non-empty array of at most 20 quotes within 16 KiB.
      expect(await bad("ok", "fact", "[]")).toBe("23514");
      expect(await bad("ok", "fact", '{"quote":"x"}')).toBe("23514");
      expect(await bad("ok", "fact", JSON.stringify(Array(21).fill({ q: "x" })))).toBe("23514");
      expect(await bad("ok", "fact", JSON.stringify([{ q: "x".repeat(17_000) }]))).toBe("23514");
      expect(await bad("ok", "fact", JSON.stringify(Array(20).fill({ q: "x" })))).toBeUndefined();
    });
  });

  it("hold decision and reason rules", async () => {
    const p = await project(teamA);
    const t = await thread(teamA, p);
    await inTeam(teamA, async (c) => {
      const id = await suggest(c, teamA, p, t);
      const set = (fields: string, params: unknown[] = []) =>
        code(c, `UPDATE memory_project_suggestions SET ${fields} WHERE team_id = $1 AND id = $2`, [
          teamA,
          id,
          ...params,
        ]);
      // A decision needs decided_at; approved and dismissed name the decider, expired and stale
      // (KOBE-668: its thread left the project) none.
      expect(await set(`state = 'approved', decided_by = $3`, [editor])).toBe("23514");
      expect(await set(`state = 'approved', decided_at = now()`)).toBe("23514");
      expect(await set(`state = 'expired', decided_at = now(), decided_by = $3`, [editor])).toBe(
        "23514",
      );
      expect(await set(`state = 'stale', decided_at = now(), decided_by = $3`, [editor])).toBe(
        "23514",
      );
      expect(await set(`state = 'stale', decided_by = NULL`)).toBe("23514");
      expect(await set(`decided_at = now()`)).toBe("23514");
      expect(await set(`state = 'unknown', decided_at = now()`)).toBe("23514");
      // A reason only on a dismissal, 1..1000 characters.
      expect(await set(`reason = 'early'`)).toBe("23514");
      expect(
        await set(`state = 'approved', decided_at = now(), decided_by = $3, reason = 'x'`, [
          editor,
        ]),
      ).toBe("23514");
      expect(
        await set(`state = 'dismissed', decided_at = now(), decided_by = $3, reason = $4`, [
          editor,
          "x".repeat(1001),
        ]),
      ).toBe("23514");
      expect(
        await set(`state = 'dismissed', decided_at = now(), decided_by = $3, reason = ' '`, [
          editor,
        ]),
      ).toBe("23514");
      expect(
        await set(`state = 'dismissed', decided_at = now(), decided_by = $3, reason = 'Covered'`, [
          editor,
        ]),
      ).toBeUndefined();
      expect(
        await set(`state = 'approved', decided_at = now(), decided_by = $3, reason = NULL`, [
          editor,
        ]),
      ).toBeUndefined();
      expect(await set(`state = 'expired', decided_by = NULL`)).toBeUndefined();
      expect(await set(`state = 'stale', decided_by = NULL`)).toBeUndefined();
      expect(await set(`state = 'stale', reason = 'x'`)).toBe("23514");
    });
  });

  it("suggest a candidate at most once and keep their text when it goes (ref cleared)", async () => {
    const p = await project(teamA);
    const t = await thread(teamA, p);
    const { cand, id } = await inTeam(
      teamA,
      async (c) => {
        const cand = await candidate(c, teamA, t);
        const id = await suggest(c, teamA, p, t, cand);
        expect(await code(c, INSERT, [teamA, p, t, cand, "Again", "fact", EVIDENCE, reader])).toBe(
          "23505",
        );
        // A candidate that does not exist (or is another Workspace's) is refused.
        expect(
          await code(c, INSERT, [teamA, p, t, randomUUID(), "x", "fact", EVIDENCE, reader]),
        ).toBe("23503");
        return { cand, id };
      },
      true,
    );
    await inTeam(
      teamA,
      async (c) => {
        await c.query(`DELETE FROM memory_candidates WHERE team_id = $1 AND id = $2`, [
          teamA,
          cand,
        ]);
      },
      true,
    );
    const { rows } = await admin.query(
      `SELECT candidate_ref, statement FROM memory_project_suggestions WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ candidate_ref: null, statement: "Invoices are numbered per year" });
  });

  it("refuse another Workspace's project or thread", async () => {
    const pA = await project(teamA);
    const tA = await thread(teamA, pA);
    const pB = await project(teamB);
    const tB = await thread(teamB, pB);
    await inTeam(teamA, async (c) => {
      const ins = (projectId: string, threadId: string) =>
        code(c, INSERT, [teamA, projectId, threadId, null, "x", "fact", EVIDENCE, reader]);
      expect(await ins(pB, tA)).toBe("23503");
      expect(await ins(pA, tB)).toBe("23503");
      // Another Workspace's rows are refused by the policy.
      expect(await code(c, INSERT, [teamB, pB, tB, null, "x", "fact", EVIDENCE, reader])).toBe(
        "42501",
      );
    });
  });

  it("index the review queue, a thread's suggestions and the expiry sweep", async () => {
    const { rows } = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'memory_project_suggestions'`,
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef;
    expect(def("memory_project_suggestions_queue_idx")).toContain(
      "(team_id, project_id, state, created_at)",
    );
    expect(def("memory_project_suggestions_thread_idx")).toContain("(team_id, thread_id)");
    expect(def("memory_project_suggestions_expiry_idx")).toMatch(
      /\(team_id, expires_at\) WHERE \(state = 'pending'::text\)/,
    );
  });
});

describe("thread purge and project delete (SM28)", () => {
  it("take the suggestions with the thread, then with the project", async () => {
    const p = await project(teamA);
    const t = await thread(teamA, p);
    const keep = await thread(teamA, p);
    await inTeam(
      teamA,
      async (c) => {
        await suggest(c, teamA, p, t);
        await suggest(c, teamA, p, keep);
      },
      true,
    );
    const count = async (column: string, id: string) => {
      const { rows } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memory_project_suggestions WHERE ${column} = $1`,
        [id],
      );
      return rows[0]?.n;
    };
    await inTeam(
      teamA,
      (c) => c.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamA, t]),
      true,
    );
    expect(await count("thread_id", t)).toBe(0);
    expect(await count("thread_id", keep)).toBe(1);
    // A thread moved out of the project keeps its row (the server stales it, PE5); the project
    // delete takes what is left once its threads are gone.
    await admin.query(`UPDATE threads SET project_id = NULL WHERE team_id = $1 AND id = $2`, [
      teamA,
      keep,
    ]);
    expect(await count("thread_id", keep)).toBe(1);
    await inTeam(
      teamA,
      (c) => c.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [teamA, p]),
      true,
    );
    expect(await count("project_id", p)).toBe(0);
  });
});

describe("legal hold", () => {
  it("refuses deleting a held suggester's suggestions and truncating the table", async () => {
    const p = await project(teamA);
    const t = await thread(teamA, p);
    const ot = await thread(teamA, p, editor);
    const ids = await inTeam(
      teamA,
      async (c) => ({
        mine: await suggest(c, teamA, p, t),
        theirs: await suggest(c, teamA, p, ot, null, editor),
      }),
      true,
    );
    const h = await hold(teamA, reader);
    try {
      await inTeam(teamA, async (c) => {
        const del = (id: string) =>
          code(c, `DELETE FROM memory_project_suggestions WHERE team_id = $1 AND id = $2`, [
            teamA,
            id,
          ]);
        expect(await del(ids.mine)).toBe(LEGAL_HOLD_SQLSTATE);
        // The held person's thread is not purged either (the thread guard).
        expect(
          await code(c, `DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamA, t]),
        ).toBe(LEGAL_HOLD_SQLSTATE);
        // Someone else's suggestion is not covered.
        expect(await del(ids.theirs)).toBeUndefined();
      });
      await admin.query("BEGIN");
      try {
        expect(await code(admin, `TRUNCATE memory_project_suggestions`)).toBe(LEGAL_HOLD_SQLSTATE);
      } finally {
        await admin.query("ROLLBACK");
      }
    } finally {
      await release(h);
    }
    await inTeam(teamA, async (c) => {
      expect(
        await code(c, `DELETE FROM memory_project_suggestions WHERE team_id = $1 AND id = $2`, [
          teamA,
          ids.mine,
        ]),
      ).toBeUndefined();
    });
  });
});
