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
 * KOBE-767 review round 2 (R2-L4) as an upgrade runs it (the owner role) over a populated
 * database: `git_repositories.linked_at` is backfilled for Repos linked before it existed, from
 * the completed conversion for a converted Repo and from the row itself for a relinked one, so
 * the mirror sweep keeps an earlier repository's last mirror. FORCE RLS stays on.
 */
const MARKER = `SET "linked_at" = GREATEST("created_at", "updated_at")`;

let db: TestDatabase | undefined;
let older = "";
const teamId = randomUUID();
const userId = randomUUID();
const converted = randomUUID();
const relinked = randomUUID();
const loose = randomUUID();
const ids = { converted: randomUUID(), relinked: randomUUID(), loose: randomUUID() };

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
      `g${teamId.slice(0, 8)}`,
    ]);
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
      userId,
      `${userId}@upgrade.test`,
    ]);
    for (const [id, slug] of [
      [converted, "conv"],
      [relinked, "rel"],
    ] as const) {
      await c.query(
        `INSERT INTO projects (team_id, id, slug, name, kind, created_by)
         VALUES ($1, $2, $3, 'P', 'repo', $4)`,
        [teamId, id, slug, userId],
      );
    }
    await c.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'loose', 'P', $3)`,
      [teamId, loose, userId],
    );
    await c.query(
      `INSERT INTO git_conversions
         (team_id, project_id, requested_by, provider, base_url, organization, repository_name,
          visibility, carry_history, default_branch, status, step, host_repo_id, finished_at)
       VALUES ($1, $2, $3, 'forgejo', 'https://git.upgrade.test', 'acme', 'conv', 'private', true,
               'main', 'completed', 'done', '1', '2026-11-01T10:00:00Z')`,
      [teamId, converted, userId],
    );
    const repo = (id: string, project: string | null, origin: string, hostId: string) =>
      c.query(
        `INSERT INTO git_repositories
           (team_id, id, base_url, host_repo_id, full_name, project_id, origin, created_by,
            created_at, updated_at)
         VALUES ($1, $2, 'https://git.upgrade.test', $3, $4, $5, $6, $7,
                 '2026-11-05T10:00:00Z', '2026-11-06T10:00:00Z')`,
        [teamId, id, hostId, `acme/r${hostId}`, project, origin, userId],
      );
    await repo(ids.converted, converted, "conversion", "1");
    await repo(ids.relinked, relinked, "link", "2");
    await repo(ids.loose, null, "tool", "3");
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("linked_at is backfilled on upgrade (KOBE-767 R2-L4)", () => {
  it("dates each Repo's link; a repository without a project keeps none; FORCE RLS stays on", async () => {
    const { rows } = await asAdmin((c) =>
      c.query<{ id: string; linked_at: Date | null }>(
        `SELECT id, linked_at FROM git_repositories WHERE team_id = $1`,
        [teamId],
      ),
    );
    const at = Object.fromEntries(rows.map((r) => [r.id, r.linked_at?.toISOString() ?? null]));
    expect(at).toEqual({
      [ids.converted]: "2026-11-01T10:00:00.000Z",
      [ids.relinked]: "2026-11-06T10:00:00.000Z",
      [ids.loose]: null,
    });
    const { rows: rls } = await asAdmin((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE oid IN ('git_repositories'::regclass, 'git_conversions'::regclass)`,
      ),
    );
    expect(rls.every((r) => r.relforcerowsecurity)).toBe(true);
  });
});
