import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { createTestDatabase, testServerUrl, type TestDatabase } from "./test-support/database.js";

// KOBE-734 (review STO-3): the runner commits each migration with its bookkeeping row, so a
// failing migration leaves the earlier ones applied, and a `-- kobe:no-transaction` migration can
// build indexes CONCURRENTLY. Synthetic migration folders on throwaway databases.

const BASE_WHEN = 1_900_000_000_000;
const dirs: string[] = [];

async function folder(files: readonly { tag: string; sql: string }[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kobe-runner-"));
  dirs.push(dir);
  await writeMigrations(dir, files);
  return dir;
}

async function writeMigrations(dir: string, files: readonly { tag: string; sql: string }[]) {
  await mkdir(path.join(dir, "meta"), { recursive: true });
  await writeFile(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: files.map((f, idx) => ({
        idx,
        version: "7",
        when: BASE_WHEN + idx * 1000,
        tag: f.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const f of files) await writeFile(path.join(dir, `${f.tag}.sql`), f.sql);
}

const A = { tag: "0000_a", sql: "CREATE TABLE t_a (id int PRIMARY KEY);" };
const B = {
  tag: "0001_b",
  sql: "CREATE TABLE t_b (id int PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO t_b VALUES (1);",
};
const BAD = {
  tag: "0002_c",
  sql: "CREATE TABLE t_c (id int PRIMARY KEY);\n--> statement-breakpoint\nSELECT 1 / 0;",
};
const GOOD_C = { tag: "0002_c", sql: "CREATE TABLE t_c (id int PRIMARY KEY);" };

let db: TestDatabase;
let admin: pg.Client;

beforeEach(async () => {
  db = await createTestDatabase(testServerUrl(), {
    migrationsFolder: await folder([A]),
    vector: false,
  });
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
}, 120_000);

afterEach(async () => {
  await admin.end();
  await db.drop();
});

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const recorded = async () =>
  (
    await admin.query<{ hash: string; created_at: string }>(
      `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    )
  ).rows.map((r) => ({ hash: r.hash, folderMillis: Number(r.created_at) }));

const exists = async (table: string) =>
  (await admin.query(`SELECT to_regclass($1) AS t`, [table])).rows[0]?.t !== null;

const migrateWith = (dir: string) =>
  runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole, migrationsFolder: dir });

describe("migration runner: one transaction per migration (KOBE-734)", () => {
  it("leaves 1..N-1 applied and recorded when N fails; a rerun continues", async () => {
    const dir = await folder([A, B, BAD]);
    await expect(migrateWith(dir)).rejects.toThrow(/0002_c.*division by zero/s);
    // Bookkeeping identical to drizzle's: same hashes, created_at = the journal's `when`.
    const expected = readMigrationFiles({ migrationsFolder: dir }).map((m) => ({
      hash: m.hash,
      folderMillis: m.folderMillis,
    }));
    expect(await recorded()).toEqual(expected.slice(0, 2));
    expect(await exists("t_b")).toBe(true);
    expect(await exists("t_c")).toBe(false);

    await writeMigrations(dir, [A, B, GOOD_C]);
    await migrateWith(dir);
    const fixed = readMigrationFiles({ migrationsFolder: dir }).map((m) => ({
      hash: m.hash,
      folderMillis: m.folderMillis,
    }));
    expect(await recorded()).toEqual(fixed);
    expect(await exists("t_c")).toBe(true);
    // drizzle's own migrator agrees there is nothing left to apply.
    const pool = new pg.Pool({ connectionString: db.ownerUrl, max: 1 });
    try {
      await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    } finally {
      await pool.end();
    }
    expect(await recorded()).toHaveLength(3);
  });

  it("continues an install that drizzle's migrator (earlier releases) migrated", async () => {
    const dir = await folder([A, B]);
    const pool = new pg.Pool({ connectionString: db.ownerUrl, max: 1 });
    try {
      // The test database's runner already recorded A; drizzle applies B on top, as before.
      await migrate(drizzle({ client: pool }), { migrationsFolder: dir });
    } finally {
      await pool.end();
    }
    expect(await recorded()).toHaveLength(2);
    await writeMigrations(dir, [A, B, GOOD_C]);
    await migrateWith(dir);
    expect(await recorded()).toEqual(
      readMigrationFiles({ migrationsFolder: dir }).map((m) => ({
        hash: m.hash,
        folderMillis: m.folderMillis,
      })),
    );
    expect(await exists("t_c")).toBe(true);
  });

  it("still grants the app role after the last migration", async () => {
    // A fresh database: the grants marker names the newest applied migration.
    const dir = await folder([A, B]);
    await migrateWith(dir);
    const { rows } = await admin.query<{ w: string }>(
      `SELECT migration_when AS w FROM drizzle.kobe_grants_applied`,
    );
    expect(Number(rows[0]?.w)).toBe(BASE_WHEN + 1000);
  });
});

describe("migration runner: -- kobe:no-transaction (KOBE-734)", () => {
  const INDEX = {
    tag: "0001_idx",
    sql: [
      "-- kobe:no-transaction",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_a_v_uniq ON t_a (v);",
    ].join("\n"),
  };

  it("builds an index CONCURRENTLY and records it", async () => {
    await admin.query(`ALTER TABLE t_a ADD COLUMN v int`);
    const dir = await folder([A, INDEX]);
    await migrateWith(dir);
    const { rows } = await admin.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = 't_a_v_uniq'::regclass`,
    );
    expect(rows).toEqual([{ valid: true }]);
    expect(await recorded()).toHaveLength(2);
  });

  it("rebuilds an INVALID index left by an interrupted concurrent build", async () => {
    await admin.query(`ALTER TABLE t_a ADD COLUMN v int`);
    await admin.query(`INSERT INTO t_a VALUES (1, 7), (2, 7)`);
    // An earlier run died half-way: the duplicate makes the build fail and leave the index INVALID.
    await expect(
      admin.query(`CREATE UNIQUE INDEX CONCURRENTLY t_a_v_uniq ON t_a (v)`),
    ).rejects.toThrow();
    const invalid = await admin.query<{ valid: boolean }>(
      `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 't_a_v_uniq'::regclass`,
    );
    expect(invalid.rows).toEqual([{ valid: false }]);
    await admin.query(`DELETE FROM t_a WHERE id = 2`);

    const dir = await folder([A, INDEX]);
    await migrateWith(dir);
    const { rows } = await admin.query<{ valid: boolean }>(
      `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 't_a_v_uniq'::regclass`,
    );
    expect(rows).toEqual([{ valid: true }]);
    await expect(admin.query(`INSERT INTO t_a VALUES (3, 7)`)).rejects.toThrow(/duplicate/);
  });

  it("refuses a statement that is not an idempotent concurrent index build or drop", async () => {
    const dir = await folder([
      A,
      { tag: "0001_bad", sql: "-- kobe:no-transaction\nCREATE INDEX CONCURRENTLY x ON t_a (id);" },
    ]);
    await expect(migrateWith(dir)).rejects.toThrow(/0001_bad.*IF NOT EXISTS/s);
    expect(await recorded()).toHaveLength(1);
  });
});
