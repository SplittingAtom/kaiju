import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, verifyAuditChain } from "@kaiju/db";
import {
  createTestDatabase,
  migrationsBefore,
  testNameSuffix,
  testServerUrl,
  type TestDatabase,
} from "@kaiju/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackup } from "./backup.js";
import { runRestore } from "./restore.js";
import { BLOB_REFS, memoryLister, sql, T1, U1 } from "./testing/fixtures.js";

/**
 * KOBE-826 ac-3: a backup taken before the built-in connectors were renamed (`kaiju-backup/*`
 * manifests keep their `kobe-backup/*` format ids) restores on the release it was taken with and
 * then goes through the upgrade's migrations like any database of that release: the built-ins,
 * their tool names in rules and the settings keys are renamed, the audit chain still verifies. A
 * site already on the renamed schema refuses it before loading anything (same migrations only).
 */
const pgBinDir = process.env.KAIJU_PG_BIN_DIR || undefined;
const KEY = randomBytes(32);
const MARKER = "-- KOBE-826 (rename step RN-13";
const KAIJU_ID = "6b6f6265-0000-4000-8000-000000000001";
const GIT_ID = "6b6f6265-0000-4000-8000-000000000002";

describe("a backup taken before the built-in connectors' rename (KOBE-826)", () => {
  const server = testServerUrl();
  const suffix = testNameSuffix();
  const backupRole = `kaiju_backup_826_${suffix}`;
  const password = randomBytes(16).toString("hex");
  const created: TestDatabase[] = [];
  let oldMigrations = "";
  let work = "";

  beforeAll(async () => {
    oldMigrations = migrationsBefore(MARKER);
    const src = await createTestDatabase(server, { migrationsFolder: oldMigrations });
    created.push(src);
    await sql(
      src.adminUrl,
      `INSERT INTO users (id, name, email) VALUES ('${U1}', 'Ann', 'ann@example.com');
       INSERT INTO teams (id, slug, name, settings)
         VALUES ('${T1}', 'finance', 'Finance', '{"kobe_mcp.admin": "read"}');
       INSERT INTO team_members (team_id, user_id, role) VALUES ('${T1}', '${U1}', 'team_admin');
       INSERT INTO connectors (id, name, url, auth_kind, credential_source, builtin) VALUES
         ('${KAIJU_ID}', 'kobe', 'http://kobe-server.internal/internal/v1/mcp/kobe', 'none', 'member', 'kobe'),
         ('${GIT_ID}', 'kobe-git', 'http://kobe-server.internal/internal/v1/mcp/git', 'none', 'member', 'git');
       INSERT INTO site_settings (key, value) VALUES ('kobe_mcp.mode', 'admin');
       INSERT INTO site_tool_rules (effect, tool_glob, created_by)
         VALUES ('deny', 'mcp__kobe__site_*', '${U1}');
       INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
         VALUES ('${T1}', 'user', '${U1}', 'allow', 'mcp__kobe_git__git_comment', '${U1}', 'forever');`,
    );
    await sql(
      server,
      `CREATE ROLE ${backupRole} LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data`,
    );
    const url = new URL(src.adminUrl);
    url.username = backupRole;
    url.password = password;
    work = await mkdtemp(join(tmpdir(), "kaiju-826-backup-"));
    const manifest = await runBackup({
      databaseUrl: url.toString(),
      out: join(work, "old"),
      key: KEY,
      objects: memoryLister([]),
      blobRefColumns: BLOB_REFS.filter((c) => c.table !== "widgets"),
      pgBinDir,
    });
    expect(manifest.format).toMatch(/^kobe-backup\//);
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

  it("restores on its own release, then the upgrade renames what it holds", async () => {
    const dst = await createTestDatabase(server, { migrationsFolder: oldMigrations });
    created.push(dst);
    await restore(dst);
    await runMigrations({ databaseUrl: dst.ownerUrl, appRole: dst.appRole });
    expect(
      await sql(dst.adminUrl, `SELECT id, name, builtin FROM connectors ORDER BY name`),
    ).toEqual([
      { id: KAIJU_ID, name: "kaiju", builtin: "kaiju" },
      { id: GIT_ID, name: "kaiju-git", builtin: "git" },
    ]);
    expect(await sql(dst.adminUrl, `SELECT tool_glob FROM site_tool_rules`)).toEqual([
      { tool_glob: "mcp__kaiju__site_*" },
    ]);
    expect(await sql(dst.adminUrl, `SELECT tool_glob, remember_scope FROM tool_rules`)).toEqual([
      { tool_glob: "mcp__kaiju_git__git_comment", remember_scope: "forever" },
    ]);
    expect(
      await sql(
        dst.adminUrl,
        `SELECT key, value FROM site_settings WHERE key LIKE 'k%mcp.%' ORDER BY key`,
      ),
    ).toEqual([
      { key: "kaiju_mcp.mode", value: "admin" },
      {
        key: "kaiju_mcp.renamed",
        value: '{"segments": {"kobe": "kaiju", "kobe_git": "kaiju_git"}, "registered": {}}',
      },
    ]);
    expect(await sql(dst.adminUrl, `SELECT settings FROM teams`)).toEqual([
      { settings: { "kaiju_mcp.admin": "read" } },
    ]);
    const app = createDb(dst.appUrl);
    try {
      expect((await verifyAuditChain(app.db)).ok).toBe(true);
    } finally {
      await app.close();
    }
  }, 180_000);

  it("is refused by a site on the renamed schema, before anything is loaded", async () => {
    const dst = await createTestDatabase(server);
    created.push(dst);
    await expect(restore(dst)).rejects.toThrow(/schema does not match the backup/);
    expect(await sql(dst.adminUrl, `SELECT count(*)::int AS n FROM connectors`)).toEqual([
      { n: 0 },
    ]);
  }, 180_000);
});
