import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@kaiju/db";
import {
  createTestDatabase,
  migrationsBefore,
  serverHasPgvector,
  testNameSuffix,
  testServerUrl,
  type TestDatabase,
} from "@kaiju/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";
import { BLOB_REFS, memoryLister, sql, T1, U1 } from "./testing/fixtures.js";

/**
 * KOBE-828 (RN-15): a backup taken before the in-cluster models were renamed (`kobe-local/...`)
 * restores on the release it was taken with and then goes through the upgrade's migrations like
 * any database of that release: the Site embedding model and the vectors' model become
 * `kaiju-local/...` with the vectors kept, and the usage ledger keeps the ids it was written with.
 * A site already on the renamed schema refuses it before loading anything (same migrations only).
 */
const pgBinDir = process.env.KAIJU_PG_BIN_DIR || undefined;
const KEY = randomBytes(32);
const MARKER = "-- KOBE-828 (rename step RN-15";
const ITEM = "8b6f6265-0000-4000-8000-000000000828";
const pgvector = await serverHasPgvector(testServerUrl());

describe("a backup taken before the kaiju-local rename (KOBE-828)", () => {
  const server = testServerUrl();
  const suffix = testNameSuffix();
  const backupRole = `kaiju_backup_828_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const created: TestDatabase[] = [];
  let oldMigrations = "";
  let work = "";

  beforeAll(async () => {
    oldMigrations = migrationsBefore(MARKER);
    const src = await createTestDatabase(server, { migrationsFolder: oldMigrations });
    created.push(src);
    const vector = pgvector
      ? `, embedding = '[0.5,0.25]', embedding_model = 'kobe-local/nomic-embed-text#d2', embedding_dims = 2`
      : "";
    await sql(
      src.adminUrl,
      `INSERT INTO users (id, name, email) VALUES ('${U1}', 'Ann', 'ann@example.com');
       INSERT INTO teams (id, slug, name) VALUES ('${T1}', 'finance', 'Finance');
       INSERT INTO team_members (team_id, user_id, role) VALUES ('${T1}', '${U1}', 'team_admin');
       INSERT INTO site_settings (key, value)
         VALUES ('memory.settings', '{"embedding_model": "kobe-local/nomic-embed-text"}');
       WITH i AS (INSERT INTO semantic_memory_items (team_id, id, scope, kind)
                  VALUES ('${T1}', '${ITEM}', 'team', 'fact') RETURNING team_id, id)
       INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement,
         actor_kind, actor_user_id)
       SELECT team_id, id, 1, 'The fiscal year starts in April', 'user', '${U1}' FROM i;
       UPDATE semantic_memory_item_versions SET statement = statement ${vector};
       INSERT INTO run_usage (team_id, user_id, kind, route, model, status, input_tokens,
         output_tokens, usage_source, cost_usd, duration_ms)
       VALUES ('${T1}', '${U1}', 'memory_embed', 'openai', 'kobe-local/nomic-embed-text', 200, 7,
         0, 'reported', 0, 5);`,
    );
    await sql(
      server,
      `CREATE ROLE ${backupRole} LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data`,
    );
    const url = new URL(src.adminUrl);
    url.username = backupRole;
    url.password = password;
    work = await mkdtemp(join(tmpdir(), "kaiju-828-backup-"));
    await runBackup({
      databaseUrl: url.toString(),
      out: join(work, "old"),
      key: KEY,
      objects: memoryLister([]),
      blobRefColumns: BLOB_REFS.filter((c) => c.table !== "widgets"),
      pgBinDir,
    });
  }, 180_000);

  afterAll(async () => {
    for (const db of created) await db.drop().catch(() => undefined);
    await sql(server, `DROP ROLE IF EXISTS ${backupRole}`).catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true });
    if (oldMigrations) await rm(oldMigrations, { recursive: true, force: true });
  });

  const restore = (dst: TestDatabase) =>
    runRestore({
      databaseUrl: dst.ownerUrl,
      from: join(work, "old"),
      key: KEY,
      objects: memoryLister([]),
      allowObjectMismatch: false,
      skipObjects: false,
      pgBinDir,
    });

  it("restores on its own release, then the upgrade renames the stored model ids", async () => {
    const dst = await createTestDatabase(server, { migrationsFolder: oldMigrations });
    created.push(dst);
    await restore(dst);
    await runMigrations({ databaseUrl: dst.ownerUrl, appRole: dst.appRole });
    expect(
      await sql(dst.adminUrl, `SELECT value FROM site_settings WHERE key = 'memory.settings'`),
    ).toEqual([{ value: '{"embedding_model": "kaiju-local/nomic-embed-text"}' }]);
    if (pgvector) {
      expect(
        await sql(
          dst.adminUrl,
          `SELECT embedding_model AS m, embedding::text AS v FROM semantic_memory_item_versions`,
        ),
      ).toEqual([{ m: "kaiju-local/nomic-embed-text#d2", v: "[0.5,0.25]" }]);
    }
    expect(await sql(dst.adminUrl, `SELECT model FROM run_usage`)).toEqual([
      { model: "kobe-local/nomic-embed-text" },
    ]);
  }, 180_000);

  it("is refused by a site on the renamed schema, before anything is loaded", async () => {
    const dst = await createTestDatabase(server);
    created.push(dst);
    await expect(restore(dst)).rejects.toThrow(/schema does not match the backup/);
    expect(await sql(dst.adminUrl, `SELECT count(*)::int AS n FROM site_settings`)).toEqual([
      { n: 0 },
    ]);
  }, 180_000);
});
