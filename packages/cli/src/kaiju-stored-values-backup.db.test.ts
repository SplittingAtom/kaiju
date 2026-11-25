import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@kaiju/db";
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
import { BLOB_REFS, memoryLister, sql, U1 } from "./testing/fixtures.js";

/**
 * KOBE-831 (RN-18): a backup taken before the stored `kobe` values were renamed restores on the
 * release it was taken with and then goes through the upgrade's migrations like any database of
 * that release: Kaiju's catalog skills are published by `kaiju`, their provenance and the frozen
 * tool manifests say `kaiju`, and the gallery agent keeps its id under the key and slug `kaiju`
 * (ac-3). A site already on the renamed schema refuses it before loading anything.
 */
const pgBinDir = process.env.KAIJU_PG_BIN_DIR || undefined;
const KEY = randomBytes(32);
const MARKER = "-- KOBE-831 (rename step RN-18";
const SKILL = "8b6f6265-0000-4000-8000-000000000831";
const VERSION = "8b6f6265-0000-4000-8000-000000000832";
const AGENT = "8b6f6265-0000-4000-8000-000000000833";
/** The Kaiju version's stored bytes (backups check every referenced object is in the bucket). */
const OBJECTS = [{ key: "k", size: 10, etag: "e" }];
const MANIFEST = JSON.stringify({
  format: 1,
  floor: "site",
  tools: [{ name: "remember", source: "kobe", risk: "write", scope: "kobe", open_world: false }],
  connectors: "all",
  tools_allow: [],
  tools_deny: [],
  excluded: [],
  approval_mode: { requested: null, floor: "ask-on-write", effective: "ask-on-write" },
});

describe("a backup taken before the stored kobe values were renamed (KOBE-831)", () => {
  const server = testServerUrl();
  const suffix = testNameSuffix();
  const backupRole = `kaiju_backup_831_${suffix}`;
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
       INSERT INTO registry_skills (id, name, summary, publisher)
         VALUES ('${SKILL}', 'pdf', 'PDFs.', 'kobe');
       INSERT INTO registry_versions (id, skill_id, publisher, semver, seq, runtime_hash,
         package_hash, runtime_storage_key, runtime_size_bytes, manifest, provenance, source, scan,
         verdict, state, approved_at)
       VALUES ('${VERSION}', '${SKILL}', 'kobe', '1.0.0', 1, repeat('a', 64), repeat('b', 64),
         'k', 10, '{}', '{"publisher": "kobe", "scan": {"scanner": {"name": "kobe-skill-scanner"}}}',
         '{}', '{}', 'pass', 'approved', now());
       INSERT INTO site_agents (id, scope, slug, frontmatter, prompt, gallery_key, gallery_generation)
         VALUES ('${AGENT}', 'gallery', 'kobe', '{"name":"Kobe"}', 'You are Kobe.', 'kobe', 4);
       INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest,
         draft_revision) VALUES ('${AGENT}', 1, '{"name":"Kobe"}', 'You are Kobe.', '${MANIFEST}', 1);
       UPDATE site_agents SET current_version = 1 WHERE id = '${AGENT}';`,
    );
    await sql(
      server,
      `CREATE ROLE ${backupRole} LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS IN ROLE pg_read_all_data`,
    );
    const url = new URL(src.adminUrl);
    url.username = backupRole;
    url.password = password;
    work = await mkdtemp(join(tmpdir(), "kaiju-831-backup-"));
    await runBackup({
      databaseUrl: url.toString(),
      out: join(work, "old"),
      key: KEY,
      objects: memoryLister(OBJECTS),
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
      objects: memoryLister(OBJECTS),
      allowObjectMismatch: false,
      skipObjects: false,
      pgBinDir,
    });

  it("restores on its own release, then the upgrade renames the stored values", async () => {
    const dst = await createTestDatabase(server, { migrationsFolder: oldMigrations });
    created.push(dst);
    await restore(dst);
    await runMigrations({ databaseUrl: dst.ownerUrl, appRole: dst.appRole });
    expect(
      await sql(
        dst.adminUrl,
        `SELECT s.publisher::text AS s, v.publisher::text AS v, v.provenance->>'publisher' AS p,
                v.provenance#>>'{scan,scanner,name}' AS scanner
           FROM registry_skills s JOIN registry_versions v ON v.skill_id = s.id`,
      ),
    ).toEqual([{ s: "kaiju", v: "kaiju", p: "kaiju", scanner: "kaiju-skill-scanner" }]);
    expect(
      await sql(
        dst.adminUrl,
        `SELECT a.id, a.slug, a.gallery_key AS key, v.tool_manifest->'tools'->0->>'source' AS source,
                v.tool_manifest->'tools'->0->>'scope' AS scope
           FROM site_agents a JOIN site_agent_versions v ON v.agent_id = a.id`,
      ),
    ).toEqual([{ id: AGENT, slug: "kaiju", key: "kaiju", source: "kaiju", scope: "kaiju" }]);
  }, 180_000);

  it("is refused by a site on the renamed schema, before anything is loaded", async () => {
    const dst = await createTestDatabase(server);
    created.push(dst);
    await expect(restore(dst)).rejects.toThrow(/schema does not match the backup/);
    expect(await sql(dst.adminUrl, `SELECT count(*)::int AS n FROM site_agents`)).toEqual([
      { n: 0 },
    ]);
  }, 180_000);
});
