import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-668 (Gate B decision 13) as an upgrade runs it (the owner role) over a populated database:
 * readers' suggestions get a `stale` state (their thread left the project) apart from `expired`
 * (the 30-day sweep), and `memory.suggestion.stale` notifications. An `expired` row decided
 * before its `expires_at` can only have been staled (the sweep needs `expires_at <= now()`), so it
 * becomes `stale`; every other row keeps its state. FORCE RLS stays on.
 */
const MARKER = `UPDATE "memory_project_suggestions" SET "state" = 'stale'`;

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const reader = randomUUID();
const editor = randomUUID();
const projectId = randomUUID();
const threadId = randomUUID();
const ids = {
  pending: randomUUID(),
  movedEarly: randomUUID(),
  swept: randomUUID(),
  movedLate: randomUUID(),
  approved: randomUUID(),
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      teamId,
      `t${teamId.slice(0, 8)}`,
    ]);
    for (const id of [reader, editor])
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
        id,
        `${id}@upgrade.test`,
      ]);
    await c.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'p', 'P', $3)`,
      [teamId, projectId, editor],
    );
    await c.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, project_id) VALUES ($1, $2, $3, 'T', $4)`,
      [teamId, threadId, reader, projectId],
    );
    const add = (id: string, state: string, decidedAt: string | null, expiresAt: string) =>
      c.query(
        `INSERT INTO memory_project_suggestions
           (team_id, id, project_id, thread_id, statement, kind, evidence, suggested_by, state,
            decided_by, decided_at, expires_at)
         VALUES ($1, $2, $3, $4, 'Invoices are numbered per year', 'fact',
                 '[{"entry_id":"a","quote":"q"}]', $5, $6, $7, $8::timestamptz, $9::timestamptz)`,
        [
          teamId,
          id,
          projectId,
          threadId,
          reader,
          state,
          state === "approved" ? editor : null,
          decidedAt,
          expiresAt,
        ],
      );
    await add(ids.pending, "pending", null, "2030-01-31");
    // Thread moved on day 5 of 30: decided well before expires_at.
    await add(ids.movedEarly, "expired", "2026-11-05", "2026-11-30");
    // The sweep: decided at or after expires_at.
    await add(ids.swept, "expired", "2026-11-02", "2026-11-01");
    // Moved after expires_at but before the nightly sweep: indistinguishable, stays expired.
    await add(ids.movedLate, "expired", "2026-12-01 10:00", "2026-12-01");
    await add(ids.approved, "approved", "2026-11-03", "2026-11-30");
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("Stale suggestions apart from expired ones on upgrade (KOBE-668)", () => {
  it("re-labels only the rows whose reason the data proves", async () => {
    const { rows } = await asAdmin((c) =>
      c.query<{ id: string; state: string; decided_by: string | null }>(
        `SELECT id, state, decided_by FROM memory_project_suggestions`,
      ),
    );
    const state = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    expect(state).toEqual({
      [ids.pending]: "pending",
      [ids.movedEarly]: "stale",
      [ids.swept]: "expired",
      [ids.movedLate]: "expired",
      [ids.approved]: "approved",
    });
  });

  it("checks the new state and notification kind, with FORCE RLS still on", async () => {
    const { rows } = await asAdmin((c) =>
      c.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname IN ('memory_project_suggestions_state', 'notifications_kind')`,
      ),
    );
    const def = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
    expect(def.memory_project_suggestions_state).toContain("'stale'");
    expect(def.notifications_kind).toContain("'memory.suggestion.stale'");
    const { rows: rls } = await asAdmin((c) =>
      c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE oid = 'memory_project_suggestions'::regclass`,
      ),
    );
    expect(rls[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
