import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { strToU8, zipSync, type Zippable } from "fflate";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { scanSkillBundle } from "@kaiju/skill-scanner";
import { runWithAuditContext } from "../audit/context.js";
import { uploadProjectFile } from "../projects/files.js";
import { validateZipBundle } from "../skills/bundle.js";
import { PostgresSkillStore } from "../skills/skill-store.js";
import type { SkillLocation } from "../skills/store.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { storeUpload } from "../uploads/store.js";
import { deleteReleasedBlobs, type BlobStore } from "./blobs.js";
import { runRetentionPass } from "./job.js";
import { ORPHAN_GRACE_MS, sweepOrphanObjects } from "./orphans.js";

/**
 * KOBE-740: object-store writes outside thread trees that happen before their database commit.
 * A crash between the put and the commit is simulated by a store that keeps the bytes but then
 * fails (as a lost connection would) and refuses every delete, so the writer can neither commit
 * nor clean up: what is left must be taken by the retention pass, never kept for ever.
 */
let h: Harness;
const objects = new MemoryObjects();
const PREFIX = "kaiju/";
const store: BlobStore = { objects, prefix: PREFIX };
let team = "";
let user = "";
let admin = "";
let project = "";
const DAY = 86_400_000;
const noRecord = () => Promise.resolve();
const asUser = <T>(fn: () => Promise<T>) =>
  runWithAuditContext({ actor: { kind: "user", id: user }, ip: null, userAgent: null }, fn);

/** Stores the bytes, then fails; deletes always fail. `failPut: false` lets puts succeed. */
function crashing(failPut = true): BlobStore {
  const lost = () => Promise.reject(new Error("connection lost"));
  return {
    prefix: PREFIX,
    objects: Object.assign(Object.create(objects) as MemoryObjects, {
      put: async (key: string, body: Readable, size: number) => {
        await objects.put(key, body, size);
        if (failPut) await lost();
      },
      putStream: async (key: string, body: Readable) => {
        await objects.putStream(key, body);
        if (failPut) await lost();
      },
      delete: lost,
    }),
  };
}

async function queued(): Promise<{ key: string; due: boolean }[]> {
  const { rows } = await h.admin.query<{ key: string; due: boolean }>(
    `SELECT key, enqueued_at <= now() AS due FROM retention_blob_deletions WHERE team_id = $1
      ORDER BY key`,
    [team],
  );
  return rows;
}

/** The reservations come due (hours later). */
const makeDue = () =>
  h.admin.query(
    `UPDATE retention_blob_deletions SET enqueued_at = now() - interval '1 minute' WHERE team_id = $1`,
    [team],
  );

const ageAll = (ms: number) => {
  for (const key of objects.keys()) objects.age(key, ms);
};

beforeAll(async () => {
  h = await openHarness({ blobs: store });
  user = await h.createUser("owner@crash.test", "owner");
  admin = await h.createUser("admin@crash.test", "admin");
  team = (
    await asUser(() =>
      createTeamWithAdmin(h.deps.database.db, { slug: "crash", name: "crash" }, user),
    )
  ).id;
  project = randomUUID();
  await h.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'p', 'P', $3)`,
    [team, project, user],
  );
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  objects.objects.clear();
  objects.modified.clear();
  objects.deleted.length = 0;
  await h.admin.query(`DELETE FROM retention_blob_deletions`);
  await h.admin.query(`UPDATE projects SET archived_at = NULL WHERE id = $1`, [project]);
});

describe("project file staging (projects/files.ts)", () => {
  const upload = (blobs: BlobStore, name = `${randomUUID()}.txt`) =>
    asUser(() =>
      uploadProjectFile(
        {
          db: h.deps.database.db,
          blobs,
          maxFileBytes: 1_000_000,
          teamQuotaDefaultBytes: 1_000_000_000,
        },
        { teamId: team, projectId: project, userId: user },
        {
          folder: undefined,
          name,
          declaredMime: "text/plain",
          body: Readable.from([Buffer.from("hello")]),
        },
      ),
    );
  const tree = `${PREFIX}teams/`;

  it("a crash after the staging put leaves an object the blob deleter takes once due", async () => {
    expect(await upload(crashing())).toEqual({ ok: false, error: "storage_failed" });
    const left = objects.keys(tree);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/\/projects\/[^/]+\/staging\/[0-9a-f-]{36}$/);
    // Staging and file keys were reserved before the put, not yet due.
    expect((await queued()).map((q) => q.due)).toEqual([false, false]);
    await makeDue();
    const res = await deleteReleasedBlobs(h.deps.database.db, team, store, noRecord);
    expect(res.blobs).toBe(2);
    expect(objects.keys(tree)).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("a commit that fails after the copy leaves both objects queued, and both go", async () => {
    await h.admin.query(`UPDATE projects SET archived_at = now() WHERE id = $1`, [project]);
    expect(await upload(crashing(false))).toEqual({ ok: false, error: "archived" });
    expect(objects.keys(tree)).toHaveLength(2);
    await makeDue();
    await deleteReleasedBlobs(h.deps.database.db, team, store, noRecord);
    expect(objects.keys(tree)).toEqual([]);
  });

  it("a stored file keeps its object and leaves nothing queued", async () => {
    const result = await upload(store);
    expect(result.ok).toBe(true);
    const left = objects.keys(tree);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/\/projects\/[^/]+\/files\/[0-9a-f-]{36}$/);
    expect(await queued()).toEqual([]);
  });
});

describe("member-level uploads (uploads/store.ts)", () => {
  it("a crash after the put leaves an object the orphan sweep takes once old", async () => {
    const result = await asUser(() =>
      storeUpload(
        {
          db: h.deps.database.db,
          blobs: crashing(),
          settings: {
            maxFileBytes: 1000,
            maxMessageBytes: 5000,
            defaultQuotaBytes: 100_000,
            orphanHours: 24,
          },
        },
        { teamId: team, userId: user },
        {
          threadId: undefined,
          name: "a.txt",
          declaredMime: "text/plain",
          file: Readable.from([Buffer.from("hello")]),
          contentLength: undefined,
        },
      ),
    );
    expect(result.ok).toBe(false);
    const [key] = objects.keys();
    expect(key).toBe(objects.keys(`${PREFIX}teams/${team}/users/${user}/uploads/`)[0]);
    expect(await queued()).toEqual([]);
    const sweep = () => sweepOrphanObjects(h.deps.database.db, team, store);
    expect((await sweep()).uploads).toBe(0);
    ageAll(ORPHAN_GRACE_MS + 60_000);
    expect(await sweep()).toEqual({ staging: 0, forks: 0, uploads: 1, skills: 0, evals: 0 });
    expect(objects.keys()).toEqual([]);
  });

  it("keeps an upload its files row references, however old", async () => {
    const fileId = randomUUID();
    const key = `${PREFIX}teams/${team}/users/${user}/uploads/${fileId}`;
    objects.objects.set(key, Buffer.from("x"));
    objects.age(key, 3 * DAY);
    await h.admin.query(
      `INSERT INTO files (team_id, id, user_id, kind, name, size_bytes, sha256, mime_type, blob_ref)
       VALUES ($1, $2, $3, 'upload', 'a.txt', 1, $4, 'text/plain', $5)`,
      [team, fileId, user, "0".repeat(64), key],
    );
    try {
      expect((await sweepOrphanObjects(h.deps.database.db, team, store)).uploads).toBe(0);
      expect(objects.keys()).toEqual([key]);
    } finally {
      await h.admin.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    }
  });
});

describe("skill bundles (skills/storage.ts)", () => {
  const zip = (name: string) => {
    const bytes = zipSync({
      "SKILL.md": strToU8(`---\nname: ${name}\ndescription: Skill ${name}\n---\nBody.\n`),
    } as Zippable);
    const result = validateZipBundle(bytes);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const putSkill = (blobs: BlobStore, location: SkillLocation, name: string) =>
    asUser(() =>
      new PostgresSkillStore(h.deps.database.db, blobs).putPackage(location, {
        bundle: zip(name),
        source: "zip",
        uploadedBy: user,
        scan: scanSkillBundle([]),
      }),
    );

  it("a crash after the put leaves team and personal attempts the orphan sweep takes", async () => {
    await expect(putSkill(crashing(), { scope: "team", teamId: team }, "t-crash")).rejects.toThrow(
      /connection lost/,
    );
    await expect(
      putSkill(crashing(), { scope: "personal", ownerUserId: user }, "p-crash"),
    ).rejects.toThrow(/connection lost/);
    expect(objects.keys(`${PREFIX}skills/teams/${team}/`)).toHaveLength(1);
    expect(objects.keys(`${PREFIX}skills/users/${user}/`)).toHaveLength(1);
    const sweep = () => sweepOrphanObjects(h.deps.database.db, team, store);
    expect((await sweep()).skills).toBe(0);
    ageAll(ORPHAN_GRACE_MS + 60_000);
    expect(await sweep()).toEqual({ staging: 0, forks: 0, uploads: 0, skills: 2, evals: 0 });
    expect(objects.keys()).toEqual([]);
  });

  it("keeps the bundles of committed versions, team and personal", async () => {
    expect((await putSkill(store, { scope: "team", teamId: team }, "t-kept")).ok).toBe(true);
    expect((await putSkill(store, { scope: "personal", ownerUserId: user }, "p-kept")).ok).toBe(
      true,
    );
    const kept = objects.keys(`${PREFIX}skills/`);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    ageAll(3 * DAY);
    expect((await sweepOrphanObjects(h.deps.database.db, team, store)).skills).toBe(0);
    expect(objects.keys(`${PREFIX}skills/`)).toEqual(kept);
  });

  it("a reused bundle key stays: the version naming it can never be deleted", async () => {
    const location: SkillLocation = { scope: "team", teamId: team };
    const skill = (files: Record<string, string>) => {
      const bytes = zipSync(
        Object.fromEntries(
          Object.entries({
            "SKILL.md": "---\nname: t-reuse\ndescription: Skill t-reuse\n---\nBody.\n",
            ...files,
          }).map(([k, v]) => [k, strToU8(v)]),
        ) as Zippable,
      );
      const result = validateZipBundle(bytes);
      if (!result.ok) throw new Error(result.error.code);
      return result.value;
    };
    const putBundle = (bundle: ReturnType<typeof skill>) =>
      asUser(() =>
        new PostgresSkillStore(h.deps.database.db, store).putPackage(location, {
          bundle,
          source: "zip",
          uploadedBy: user,
          scan: scanSkillBundle([]),
        }),
      );
    expect((await putBundle(skill({}))).ok).toBe(true);
    const [runtimeKey] = objects.keys(`${PREFIX}skills/teams/${team}/`);
    ageAll(3 * DAY);
    // Same runtime, a new package (evals added): the runtime object is reused, not rewritten.
    expect((await putBundle(skill({ "evals/cases.yaml": "cases: []\n" }))).ok).toBe(true);
    const { rows } = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM team_skill_versions WHERE team_id = $1 AND storage_key = $2`,
      [team, runtimeKey],
    );
    expect(rows[0]?.n).toBe(2);
    await expect(
      h.admin.query(`DELETE FROM team_skill_versions WHERE team_id = $1`, [team]),
    ).rejects.toThrow(/immutable/);
    ageAll(3 * DAY);
    expect((await sweepOrphanObjects(h.deps.database.db, team, store)).skills).toBe(0);
    expect(objects.keys(`${PREFIX}skills/teams/${team}/`)).toContain(runtimeKey);
  });

  it("keeps a team attempt while any hold is active in the team", async () => {
    await expect(putSkill(crashing(), { scope: "team", teamId: team }, "t-held")).rejects.toThrow();
    ageAll(3 * DAY);
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, NULL, 'matter', $2)
       RETURNING id`,
      [team, admin],
    );
    await h.admin.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [rows[0]?.id, user],
    );
    try {
      expect((await sweepOrphanObjects(h.deps.database.db, team, store)).skills).toBe(0);
    } finally {
      await h.admin.query(`DELETE FROM legal_holds`);
    }
    const res = await runRetentionPass({
      db: h.deps.database.db,
      blobs: store,
      logger: pino({ level: "silent" }),
      orphanGraceMs: ORPHAN_GRACE_MS,
    });
    expect(res.teams.find((t) => t.teamId === team)?.orphans.skills).toBe(1);
  });
});

describe("skill eval objects (skills/evals/start.ts)", () => {
  const evalKey = (kind: "bundle" | "fixtures", run = randomUUID(), teamId = team) =>
    `${PREFIX}teams/${teamId}/skill-evals/${run}/${kind}-${"a".repeat(64)}.zip`;

  it("sweeps old objects no run row names, and nothing of another shape", async () => {
    const run = randomUUID();
    const orphans = [evalKey("bundle", run), evalKey("fixtures", run)];
    const odd = [
      `${PREFIX}teams/${team}/skill-evals/${run}/notes.txt`,
      `${PREFIX}teams/${team}/skill-evals/not-a-uuid/bundle-${"a".repeat(64)}.zip`,
      evalKey("bundle", randomUUID(), randomUUID()),
    ];
    for (const key of [...orphans, ...odd]) objects.objects.set(key, Buffer.from("x"));
    const young = evalKey("bundle");
    objects.objects.set(young, Buffer.from("x"));
    for (const key of [...orphans, ...odd]) objects.age(key, 3 * DAY);
    expect(await sweepOrphanObjects(h.deps.database.db, team, store)).toEqual({
      staging: 0,
      forks: 0,
      uploads: 0,
      skills: 0,
      evals: 2,
    });
    expect(objects.keys().sort()).toEqual([...odd, young].sort());
  });
});
