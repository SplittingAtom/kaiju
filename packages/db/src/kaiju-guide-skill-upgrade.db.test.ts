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
 * KOBE-833 (RN-20, migration 0263) as an upgrade runs it (the owner role) over populated
 * databases (ac-1). Site 1: Kaiju's `kobe-guide` becomes `kaiju-guide` in place, so the teams'
 * installs (one pinned to 1.0.0, one tracking within the major), an opt-out, the Default tag and
 * the old version 1.0.0 all stay on the same skill; both names stay Kaiju's. Site 2: a maintainer
 * already holds `kaiju-guide`, so Kaiju's skill keeps `kobe-guide` and nothing fails.
 */
const MARKER = "-- KOBE-833 (rename step RN-20";

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Ids {
  readonly user: string;
  readonly teamPinned: string;
  readonly teamTracking: string;
  readonly teamOptedOut: string;
  readonly guide: string;
  readonly guideVersion: string;
  readonly other: string;
}

const newIds = (): Ids => ({
  user: randomUUID(),
  teamPinned: randomUUID(),
  teamTracking: randomUUID(),
  teamOptedOut: randomUUID(),
  guide: randomUUID(),
  guideVersion: randomUUID(),
  other: randomUUID(),
});

async function populate(db: TestDatabase, shape: { newNameTaken: boolean }): Promise<Ids> {
  const ids = newIds();
  await withClient(db.adminUrl, async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'u', $2)`, [
      ids.user,
      `u-${ids.user.slice(0, 8)}@upgrade.test`,
    ]);
    for (const team of [ids.teamPinned, ids.teamTracking, ids.teamOptedOut]) {
      await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
        team,
        `t${team.slice(0, 8)}`,
      ]);
    }
    await c.query(
      `INSERT INTO registry_skills (id, name, summary, publisher)
       VALUES ($1, 'kobe-guide', 'The guide.', 'kaiju')`,
      [ids.guide],
    );
    await c.query(
      `INSERT INTO registry_versions (id, skill_id, publisher, semver, seq, runtime_hash,
         package_hash, runtime_storage_key, runtime_size_bytes, manifest, provenance, source,
         scan, verdict, state, approved_at)
       VALUES ($1, $2, 'kaiju', '1.0.0', 1, repeat('a', 64), repeat('b', 64), 'k', 10,
               '{"name":"kobe-guide"}', '{}', '{}', '{}', 'pass', 'approved', now())`,
      [ids.guideVersion, ids.guide],
    );
    await c.query(
      `INSERT INTO registry_skill_tags (skill_id, tag_id, by_kobe)
       SELECT $1, id, true FROM registry_tags WHERE name = 'default'`,
      [ids.guide],
    );
    await c.query(
      `INSERT INTO team_skill_installs (team_id, skill_id, version_id, pin_mode, access, origin,
         installed_by, by_kobe, team_changed_at)
       VALUES ($1, $3, $4, 'pinned', 'default_on', 'default_tag', $5, false, now()),
              ($2, $3, $4, 'within_major', 'default_on', 'default_tag', NULL, true, NULL)`,
      [ids.teamPinned, ids.teamTracking, ids.guide, ids.guideVersion, ids.user],
    );
    await c.query(
      `INSERT INTO team_skill_optouts (team_id, skill_id, opted_out_by) VALUES ($1, $2, $3)`,
      [ids.teamOptedOut, ids.guide, ids.user],
    );
    if (shape.newNameTaken) {
      await c.query(
        `INSERT INTO registry_skills (id, name, summary) VALUES ($1, 'kaiju-guide', 'Ours.')`,
        [ids.other],
      );
    }
  });
  return ids;
}

let older = "";
const sites: { db: TestDatabase; ids: Ids }[] = [];

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  for (const newNameTaken of [false, true]) {
    const db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
    sites.push({ db, ids: await populate(db, { newNameTaken }) });
  }
  for (const { db } of sites) {
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
    // A second run is a no-op.
    await runMigrations({ databaseUrl: db.ownerUrl, appRole: db.appRole });
  }
}, 180_000);

afterAll(async () => {
  for (const { db } of sites) await db.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

const site = (i: number) => {
  const s = sites[i];
  if (!s) throw new Error("site not created");
  return s;
};

describe("kaiju-guide on upgrade (KOBE-833)", () => {
  it("renames Kaiju's kobe-guide in place: installs, pins, opt-out, tag and old version follow it", async () => {
    const { db, ids } = site(0);
    await withClient(db.adminUrl, async (c) => {
      const skills = await c.query(
        `SELECT id, name, publisher::text AS publisher FROM registry_skills ORDER BY name`,
      );
      expect(skills.rows).toEqual([{ id: ids.guide, name: "kaiju-guide", publisher: "kaiju" }]);
      const versions = await c.query(
        `SELECT id, semver, manifest FROM registry_versions WHERE skill_id = $1`,
        [ids.guide],
      );
      expect(versions.rows).toEqual([
        { id: ids.guideVersion, semver: "1.0.0", manifest: { name: "kobe-guide" } },
      ]);
      const installs = await c.query(
        `SELECT team_id, version_id, pin_mode::text AS pin_mode FROM team_skill_installs
          WHERE skill_id = $1 ORDER BY pin_mode`,
        [ids.guide],
      );
      expect(installs.rows).toEqual([
        { team_id: ids.teamPinned, version_id: ids.guideVersion, pin_mode: "pinned" },
        { team_id: ids.teamTracking, version_id: ids.guideVersion, pin_mode: "within_major" },
      ]);
      const optouts = await c.query(`SELECT team_id FROM team_skill_optouts WHERE skill_id = $1`, [
        ids.guide,
      ]);
      expect(optouts.rows).toEqual([{ team_id: ids.teamOptedOut }]);
      const tags = await c.query(
        `SELECT t.name FROM registry_skill_tags st JOIN registry_tags t ON t.id = st.tag_id
          WHERE st.skill_id = $1`,
        [ids.guide],
      );
      expect(tags.rows).toEqual([{ name: "default" }]);
    });
  });

  it("keeps Kaiju to its reserved names, one skill per name", async () => {
    const { db } = site(0);
    await withClient(db.adminUrl, async (c) => {
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('kaiju-guide', 'K.', 'kaiju')`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_name_unique" });
      await expect(
        c.query(`INSERT INTO registry_skills (name, summary) VALUES ('xlsx', 'Mine.')`),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('my-guide', 'K.', 'kaiju')`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
      // No second Kaiju skill under the old name (a previous release's seed during the roll).
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('kobe-guide', 'K.', 'kaiju')`,
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "registry_skills_pre_rename_name" });
      await expect(
        c.query(`UPDATE registry_skills SET name = 'kobe-guide' WHERE name = 'kaiju-guide'`),
      ).rejects.toMatchObject({ constraint: "registry_skills_pre_rename_name" });
      // Kaiju's skill cannot be renamed away from a reserved name.
      await expect(
        c.query(`UPDATE registry_skills SET name = 'my-guide' WHERE name = 'kaiju-guide'`),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
    });
  });

  it("leaves Kaiju's kobe-guide where a maintainer already holds kaiju-guide", async () => {
    const { db, ids } = site(1);
    await withClient(db.adminUrl, async (c) => {
      const skills = await c.query(
        `SELECT id, name, publisher::text AS publisher FROM registry_skills ORDER BY name`,
      );
      expect(skills.rows).toEqual([
        { id: ids.other, name: "kaiju-guide", publisher: "maintainer" },
        { id: ids.guide, name: "kobe-guide", publisher: "kaiju" },
      ]);
      const installs = await c.query(
        `SELECT count(*)::int AS n FROM team_skill_installs WHERE skill_id = $1`,
        [ids.guide],
      );
      expect(installs.rows).toEqual([{ n: 2 }]);
      // Both kept rows can still change.
      await c.query(`UPDATE registry_skills SET summary = 'Still ours.' WHERE id = $1`, [
        ids.other,
      ]);
      await c.query(`UPDATE registry_skills SET summary = 'Kept.' WHERE id = $1`, [ids.guide]);
    });
  });
});
