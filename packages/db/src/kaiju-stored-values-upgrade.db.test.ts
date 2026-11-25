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
 * KOBE-831 (RN-18) as an upgrade runs it (the owner role) over populated databases: the value
 * `kobe` stored in enums and rows becomes `kaiju` (ac-1). The registry publisher is renamed in
 * place (every row and CHECK follows), Kaiju-published provenance is rewritten with its
 * immutability trigger off for that one statement, and the gallery agent's key and slug move to
 * `kaiju` with its id, versions and forks kept. History (audit rows) and the frozen tool manifests
 * of published agent versions keep the old values (readers map those, `withCurrentNames`). Site 1 has another gallery agent on the slug
 * `kaiju`, so its renamed agent keeps the slug `kobe`.
 */
const MARKER = "-- KOBE-831 (rename step RN-18";

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
  readonly admin: string;
  readonly team: string;
  readonly kaijuSkill: string;
  readonly kaijuVersion: string;
  readonly reportSkill: string;
  readonly reportVersion: string;
  readonly gallery: string;
  readonly otherGallery: string;
  readonly fork: string;
  readonly teamAgent: string;
}

interface Site {
  readonly db: TestDatabase;
  readonly ids: Ids;
}

const newIds = (): Ids => ({
  user: randomUUID(),
  admin: randomUUID(),
  team: randomUUID(),
  kaijuSkill: randomUUID(),
  kaijuVersion: randomUUID(),
  reportSkill: randomUUID(),
  reportVersion: randomUUID(),
  gallery: randomUUID(),
  otherGallery: randomUUID(),
  fork: randomUUID(),
  teamAgent: randomUUID(),
});

/** A frozen manifest as versions before the rename stored it: Kaiju's tools are `kobe`. */
const manifest = () => ({
  format: 1,
  floor: "site",
  tools: [
    { name: "bash", source: "pi", risk: "destructive", scope: "sandbox", open_world: true },
    { name: "remember", source: "kobe", risk: "write", scope: "kobe", open_world: false },
    { name: "propose_file_edit", source: "kobe", risk: "read", scope: "kobe", open_world: false },
  ],
  connectors: "all",
  tools_allow: [],
  tools_deny: [],
  excluded: [],
  approval_mode: { requested: null, floor: "ask-on-write", effective: "ask-on-write" },
});

const provenance = (publisher: string | null) => ({
  apiVersion: "kobe.dev/v1",
  ...(publisher === null ? {} : { publisher }),
  name: "pdf",
  scan: {
    scanner: { name: "kobe-skill-scanner", version: "1", rulesVersion: "1" },
    verdict: "pass",
    findings: [],
  },
});

const VERSION_COLUMNS = `id, skill_id, publisher, semver, seq, runtime_hash, package_hash,
  runtime_storage_key, runtime_size_bytes, manifest, provenance, source, scan, verdict, state,
  approved_at, submitted_by, reviewed_by`;

async function populate(db: TestDatabase, shape: { slugTaken: boolean }): Promise<Site> {
  const ids = newIds();
  await withClient(db.adminUrl, async (c) => {
    for (const [id, name] of [
      [ids.user, "user"],
      [ids.admin, "admin"],
    ] as const) {
      await c.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
        id,
        name,
        `${name}-${id.slice(0, 8)}@upgrade.test`,
      ]);
    }
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A')`, [
      ids.team,
      `a${ids.team.slice(0, 8)}`,
    ]);
    // The registry: a detached Kaiju skill with its version, and a maintainer's skill.
    await c.query(
      `INSERT INTO registry_skills (id, name, summary, publisher, detached_at, detached_by,
         detached_from_version, kobe_shipped_version)
       VALUES ($1, 'pdf', 'PDFs.', 'kobe', now(), $2, '1.0.0', '1.1.0'),
              ($3, 'report', 'R.', 'maintainer', NULL, NULL, NULL, NULL)`,
      [ids.kaijuSkill, ids.admin, ids.reportSkill],
    );
    await c.query(
      `INSERT INTO registry_versions (${VERSION_COLUMNS})
       VALUES ($1, $2, 'kobe', '1.0.0', 1, repeat('a', 64), repeat('b', 64), 'k', 10, '{}', $3,
               '{}', '{}', 'pass', 'approved', now(), NULL, NULL),
              ($4, $5, 'maintainer', '1.0.0', 1, repeat('c', 64), repeat('d', 64), 'k', 10, '{}',
               $6, '{}', '{}', 'pass', 'approved', now(), $7, $8)`,
      [
        ids.kaijuVersion,
        ids.kaijuSkill,
        provenance("kobe"),
        ids.reportVersion,
        ids.reportSkill,
        provenance(null),
        ids.user,
        ids.admin,
      ],
    );
    // A maintainer row on the Kaiju skill (as a pod of the previous release could add during the
    // roll), and one on the maintainer's skill.
    await c.query(
      `INSERT INTO registry_maintainers (skill_id, user_id, added_by)
       VALUES ($1, $2, $3), ($4, $2, $3)`,
      [ids.kaijuSkill, ids.user, ids.admin, ids.reportSkill],
    );
    // The gallery agent as the seed left it (customized here), and a member's fork of it.
    await c.query(
      `INSERT INTO site_agents (id, scope, slug, frontmatter, prompt, gallery_key,
         gallery_generation, customized_at, customized_by, customized_from_generation)
       VALUES ($1, 'gallery', 'kobe', '{"name":"Kobe"}', 'You are Kobe.', 'kobe', 4, now(), $2, 4)`,
      [ids.gallery, ids.admin],
    );
    if (shape.slugTaken) {
      await c.query(
        `INSERT INTO site_agents (id, scope, slug, frontmatter, prompt)
         VALUES ($1, 'gallery', 'kaiju', '{"name":"Curated"}', 'Curated by hand.')`,
        [ids.otherGallery],
      );
    }
    await c.query(
      `INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest,
         draft_revision) VALUES ($1, 1, '{"name":"Kobe"}', 'You are Kobe.', $2, 1)`,
      [ids.gallery, manifest()],
    );
    await c.query(`UPDATE site_agents SET current_version = 1 WHERE id = $1`, [ids.gallery]);
    await c.query(
      `INSERT INTO site_agents (id, scope, owner_user_id, slug, frontmatter, prompt,
         forked_from_agent_id, forked_from_version)
       VALUES ($1, 'personal', $2, 'kobe', '{"name":"Kobe"}', 'Mine now.', $3, 1)`,
      [ids.fork, ids.user, ids.gallery],
    );
    await c.query(
      `INSERT INTO site_agent_versions (agent_id, version, frontmatter, prompt, tool_manifest,
         published_by, draft_revision) VALUES ($1, 1, '{"name":"Kobe"}', 'Mine now.', $2, $3, 1)`,
      [ids.fork, manifest(), ids.user],
    );
    // A team agent's version.
    await c.query(
      `INSERT INTO team_agents (team_id, id, owner_user_id, slug, frontmatter)
       VALUES ($1, $2, $3, 'agent', '{"name":"A"}')`,
      [ids.team, ids.teamAgent, ids.user],
    );
    await c.query(
      `INSERT INTO team_agent_versions (team_id, agent_id, version, frontmatter, prompt,
         tool_manifest, published_by, draft_revision, skill_manifest)
       VALUES ($1, $2, 1, '{"name":"A"}', 'p', $3, $4, 1, '{"skills": []}')`,
      [ids.team, ids.teamAgent, manifest(), ids.user],
    );
    // History: an audit row naming Kaiju's publisher and the gallery agent's slug.
    await c.query(
      `INSERT INTO audit_log (actor_kind, action, target) VALUES
         ('system', 'agent.published',
          jsonb_build_object('agentId', $1::text, 'scope', 'gallery', 'slug', 'kobe', 'version', 1)),
         ('system', 'registry.version_published',
          jsonb_build_object('skillId', $2::text, 'previousPublisher', 'kobe'))`,
      [ids.gallery, ids.kaijuSkill],
    );
  });
  return { db, ids };
}

let older = "";
const sites: Site[] = [];

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  for (const slugTaken of [false, true]) {
    const db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
    sites.push(await populate(db, { slugTaken }));
  }
  for (const s of sites) {
    await runMigrations({ databaseUrl: s.db.ownerUrl, appRole: s.db.appRole });
    // Again: the migrate job of every release runs them all; a second run changes nothing.
    await runMigrations({ databaseUrl: s.db.ownerUrl, appRole: s.db.appRole });
  }
}, 240_000);

afterAll(async () => {
  for (const s of sites) await s.db.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

const site = (i: number): Site => {
  const s = sites[i];
  if (!s) throw new Error("site not created");
  return s;
};
const rows = (i: number, query: string, params: unknown[] = []) =>
  withClient(site(i).db.adminUrl, async (c) => (await c.query(query, params)).rows);
const admin = <T>(i: number, fn: (c: pg.Client) => Promise<T>) =>
  withClient(site(i).db.adminUrl, fn);

describe("the registry publisher `kaiju` (KOBE-831, ac-1)", () => {
  it("renames the enum value in place: same rows, same order of labels", async () => {
    expect(
      await rows(
        0,
        `SELECT e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'registry_publisher' ORDER BY e.enumsortorder`,
      ),
    ).toEqual([{ l: "kaiju" }, { l: "maintainer" }, { l: "site" }]);
    const { ids } = site(0);
    expect(
      await rows(0, `SELECT id, publisher::text AS p FROM registry_skills ORDER BY name`),
    ).toEqual([
      { id: ids.kaijuSkill, p: "kaiju" },
      { id: ids.reportSkill, p: "maintainer" },
    ]);
    expect(
      await rows(
        0,
        `SELECT id, publisher::text AS p FROM registry_versions ORDER BY semver, seq, p`,
      ),
    ).toEqual(
      expect.arrayContaining([
        { id: ids.kaijuVersion, p: "kaiju" },
        { id: ids.reportVersion, p: "maintainer" },
      ]),
    );
  });

  it("names kaiju in every CHECK that named the value", async () => {
    const checks = await rows(
      0,
      `SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname = ANY($1) ORDER BY conname`,
      [
        [
          "registry_skills_detached",
          "registry_skills_kobe_names",
          "registry_versions_approval",
          "registry_versions_kobe_publisher",
        ],
      ],
    );
    expect(checks).toHaveLength(4);
    for (const { n, d } of checks) {
      expect(d, n).toContain("'kaiju'");
      expect(d, n).not.toContain("'kobe'");
    }
  });

  it("enforces the checks under the new value and refuses the old one", async () => {
    const { ids } = site(0);
    await admin(0, async (c) => {
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('xlsx', 'X.', 'kobe')`,
        ),
      ).rejects.toMatchObject({ code: "22P02" });
      await expect(
        c.query(
          `INSERT INTO registry_skills (name, summary, publisher) VALUES ('my-tool', 'M.', 'kaiju')`,
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_kobe_names" });
      // A Kaiju version approved without a reviewer (the approval check compares as text).
      await c.query(
        `INSERT INTO registry_versions (${VERSION_COLUMNS})
         VALUES ($1, $2, 'kaiju', '1.1.0', 2, repeat('e', 64), repeat('f', 64), 'k', 10, '{}',
                 '{}', '{}', '{}', 'pass', 'approved', now(), NULL, NULL)`,
        [randomUUID(), ids.kaijuSkill],
      );
      await expect(
        c.query(
          `INSERT INTO registry_versions (${VERSION_COLUMNS})
           VALUES ($1, $2, 'kaiju', '1.2.0', 3, repeat('e', 64), repeat('f', 64), NULL, NULL,
                   '{}', '{}', '{}', '{}', 'pass', 'approved', now(), NULL, NULL)`,
          [randomUUID(), ids.kaijuSkill],
        ),
      ).rejects.toMatchObject({ constraint: "registry_versions_kobe_publisher" });
      // The detached Kaiju skill stays valid; a maintainer's skill cannot be detached.
      await expect(
        c.query(
          `UPDATE registry_skills SET detached_at = now(), detached_by = $2,
             detached_from_version = '1.0.0' WHERE id = $1`,
          [ids.reportSkill, ids.admin],
        ),
      ).rejects.toMatchObject({ constraint: "registry_skills_detached" });
    });
  });

  it("rewrites the stored provenance's publisher and scanner name, and nothing else", async () => {
    const { ids } = site(0);
    const got = await rows(
      0,
      `SELECT id, provenance FROM registry_versions WHERE id = ANY($1) ORDER BY semver, publisher`,
      [[ids.kaijuVersion, ids.reportVersion]],
    );
    const byId = new Map(got.map((r) => [r.id as string, r.provenance as unknown]));
    const scanner = { name: "kaiju-skill-scanner", version: "1", rulesVersion: "1" };
    expect(byId.get(ids.kaijuVersion)).toEqual({
      ...provenance("kaiju"),
      scan: { ...provenance(null).scan, scanner },
    });
    expect(byId.get(ids.reportVersion)).toEqual({
      ...provenance(null),
      scan: { ...provenance(null).scan, scanner },
    });
    // Immutable again.
    await expect(
      admin(0, (c) => c.query(`UPDATE registry_versions SET provenance = '{}'`)),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("Kaiju's skills have no maintainers (KOBE-831 review M1)", () => {
  it("removed the maintainer row on the Kaiju skill, audited, and kept the other skill's", async () => {
    const { ids } = site(0);
    expect(
      await rows(0, `SELECT skill_id, user_id FROM registry_maintainers ORDER BY skill_id`),
    ).toEqual([{ skill_id: ids.reportSkill, user_id: ids.user }]);
    expect(
      await rows(
        0,
        `SELECT actor_kind, target FROM audit_log WHERE action = 'skill.maintainer.removed'`,
      ),
    ).toEqual([{ actor_kind: "system", target: { skillId: ids.kaijuSkill, userId: ids.user } }]);
  });

  it("refuses a maintainer on a Kaiju skill from now on, as an old pod would add it", async () => {
    const { ids } = site(0);
    await admin(0, async (c) => {
      await expect(
        c.query(
          `INSERT INTO registry_maintainers (skill_id, user_id, added_by) VALUES ($1, $2, $3)`,
          [ids.kaijuSkill, ids.admin, ids.admin],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "registry_maintainers_not_kaiju" });
      await expect(
        c.query(`UPDATE registry_maintainers SET skill_id = $1 WHERE skill_id = $2`, [
          ids.kaijuSkill,
          ids.reportSkill,
        ]),
      ).rejects.toMatchObject({ constraint: "registry_maintainers_not_kaiju" });
    });
    // The app role too (the server's own connection).
    await withClient(site(0).db.appUrl, async (c) => {
      await expect(
        c.query(
          `INSERT INTO registry_maintainers (skill_id, user_id, added_by) VALUES ($1, $2, $3)`,
          [ids.kaijuSkill, ids.admin, ids.admin],
        ),
      ).rejects.toMatchObject({ constraint: "registry_maintainers_not_kaiju" });
    });
  });

  it("refuses making a maintained skill Kaiju's", async () => {
    await admin(0, async (c) => {
      const s = await c.query<{ id: string }>(
        `INSERT INTO registry_skills (name, summary) VALUES ('kobe-guide', 'Ours.') RETURNING id`,
      );
      const id = s.rows[0]?.id;
      await c.query(`INSERT INTO registry_maintainers (skill_id, user_id) VALUES ($1, $2)`, [
        id,
        site(0).ids.user,
      ]);
      await expect(
        c.query(`UPDATE registry_skills SET publisher = 'kaiju' WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ constraint: "registry_maintainers_not_kaiju" });
    });
  });
});

describe.each([0, 1])("agent versions and the gallery agent, site %i (KOBE-831)", (i) => {
  it("leaves the frozen tool manifests of published versions as they were", async () => {
    const { ids } = site(i);
    const versions = await rows(
      i,
      `SELECT agent_id, tool_manifest AS m FROM site_agent_versions
       UNION ALL SELECT agent_id, tool_manifest FROM team_agent_versions`,
    );
    const byAgent = new Map(versions.map((r) => [r.agent_id as string, r.m as unknown]));
    for (const agent of [ids.gallery, ids.fork, ids.teamAgent]) {
      expect(byAgent.get(agent), agent).toEqual(manifest());
    }
    const helper = await rows(i, `SELECT 1 FROM pg_proc WHERE proname LIKE 'kaiju_831%'`);
    expect(helper).toEqual([]);
  });

  it("moves the gallery agent's key (and slug where free); id, versions and forks stay", async () => {
    const { ids } = site(i);
    const gallery = await rows(
      i,
      `SELECT id, slug, gallery_key, gallery_generation, current_version, frontmatter->>'name' AS name,
              customized_at IS NOT NULL AS customized
         FROM site_agents WHERE id = $1`,
      [ids.gallery],
    );
    expect(gallery).toEqual([
      {
        id: ids.gallery,
        slug: i === 0 ? "kaiju" : "kobe",
        gallery_key: "kaiju",
        gallery_generation: 4,
        current_version: 1,
        // The seed renames it where it is not customized (server test); the migration never does.
        name: "Kobe",
        customized: true,
      },
    ]);
    const fork = await rows(
      i,
      `SELECT slug, frontmatter->>'name' AS name, forked_from_agent_id AS f, forked_from_version AS v
         FROM site_agents WHERE id = $1`,
      [ids.fork],
    );
    expect(fork).toEqual([{ slug: "kobe", name: "Kobe", f: ids.gallery, v: 1 }]);
    if (i === 1) {
      expect(
        await rows(i, `SELECT slug FROM site_agents WHERE id = $1`, [ids.otherGallery]),
      ).toEqual([{ slug: "kaiju" }]);
    }
    // An older pod's seed cannot add the old key back.
    await expect(
      admin(i, (c) =>
        c.query(
          `INSERT INTO site_agents (scope, slug, frontmatter, prompt, gallery_key)
           VALUES ('gallery', 'kobe-2', '{"name":"Kobe"}', 'p', 'kobe')`,
        ),
      ),
    ).rejects.toMatchObject({ constraint: "site_agents_gallery_key_renamed" });
  });

  it("keeps the old values only in history and member content: every column scanned", async () => {
    const columns = await rows(
      i,
      `SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY', 'USER-DEFINED')
          AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
        ORDER BY 1, 2`,
    );
    const found: string[] = [];
    await admin(i, async (c) => {
      for (const { t, c: col } of columns as { t: string; c: string }[]) {
        const v = `${pg.escapeIdentifier(col)}::text`;
        const hit = await c.query(
          `SELECT 1 FROM public.${pg.escapeIdentifier(t)}
            WHERE ${v} IN ('kobe', 'kobe-skill-scanner') OR ${v} LIKE '%"kobe"%'
               OR ${v} LIKE '%"kobe-skill-scanner"%' OR ${v} LIKE '%{kobe}%' OR ${v} LIKE '%{kobe,%'
            LIMIT 1`,
        );
        if (hit.rowCount) found.push(`${t}.${col}`);
      }
    });
    // audit_log: append-only history; site_agents.slug: the member's fork (and, on site 1, the
    // gallery agent, whose slug `kaiju` was taken); the versions' frozen manifests, which readers
    // map (`withCurrentNames`).
    expect(found).toEqual([
      "audit_log.target",
      "site_agent_versions.tool_manifest",
      "site_agents.slug",
      "team_agent_versions.tool_manifest",
    ]);
  });
});
