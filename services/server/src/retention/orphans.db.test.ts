import { createHash, randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { createTeamWithAdmin } from "../teams/members.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import type { BlobStore } from "./blobs.js";
import { ORPHAN_GRACE_MS, sweepOrphanObjects } from "./orphans.js";
import { runRetentionPass } from "./job.js";

/** KOBE-189: the orphaned object sweep against a real Postgres and an in-memory bucket. */
let h: Harness;
const objects = new MemoryObjects();
const PREFIX = "kaiju/";
const store: BlobStore = { objects, prefix: PREFIX };
let team = "";
let user = "";
let admin = "";
let member = "";
let ghost = "";
let otherTeam = "";
const DAY = 86_400_000;
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

const staging = (teamId = team, userId = user, prefix = PREFIX) =>
  `${prefix}teams/${teamId}/users/${userId}/workspace/incoming/${randomUUID()}`;
const forkKey = (threadId = randomUUID(), teamId = team, prefix = PREFIX) =>
  `${prefix}teams/${teamId}/threads/${threadId}/entries/${hex(randomUUID())}`;

/** Puts an object that is `ageMs` old. */
function put(key: string, ageMs: number): string {
  objects.objects.set(key, Buffer.from("x"));
  objects.age(key, ageMs);
  return key;
}
const sweep = () => sweepOrphanObjects(h.deps.database.db, team, store);

async function placeHold(userId: string | null, teamId = team): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3)
     RETURNING id`,
    [teamId, userId, admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    user,
  ]);
  return id;
}

beforeAll(async () => {
  h = await openHarness({ blobs: store });
  user = await h.createUser("owner@orphans.test", "owner");
  admin = await h.createUser("admin@orphans.test", "admin");
  member = await h.createUser("member@orphans.test");
  team = (
    await runWithAuditContext(
      { actor: { kind: "user", id: user }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "orphans", name: "orphans" }, user),
    )
  ).id;
  ghost = await h.createUser("ghost@orphans.test");
  otherTeam = (
    await runWithAuditContext(
      { actor: { kind: "user", id: user }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug: "orphans-2", name: "orphans 2" }, user),
    )
  ).id;
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, member],
  );
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  objects.objects.clear();
  objects.modified.clear();
  objects.deleted.length = 0;
  await h.admin.query(`DELETE FROM legal_holds`);
  await h.admin.query(`DELETE FROM workspace_files`);
  await h.admin.query(`DELETE FROM retention_blob_deletions`);
  await h.admin.query(`DELETE FROM threads WHERE team_id = $1`, [team]);
});

describe("staging objects", () => {
  it("deletes an old one and keeps a young one", async () => {
    const orphan = put(staging(), ORPHAN_GRACE_MS + 60_000);
    const young = put(staging(), ORPHAN_GRACE_MS - 60_000);
    expect(await sweep()).toEqual({ staging: 1, forks: 0, uploads: 0, skills: 0, evals: 0 });
    expect(objects.keys()).toEqual([young]);
    expect(objects.deleted).toEqual([orphan]);
    expect(await sweep()).toEqual({ staging: 0, forks: 0, uploads: 0, skills: 0, evals: 0 });
  });

  it("keeps one a row references", async () => {
    const key = put(staging(), 3 * DAY);
    await h.admin.query(
      `INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, 'a.txt', 1, $3, $4, 1, 1, 'server')`,
      [team, user, hex("a"), key],
    );
    expect(await sweep()).toEqual({ staging: 0, forks: 0, uploads: 0, skills: 0, evals: 0 });
    expect(objects.keys()).toEqual([key]);
  });

  it("keeps the owner's under a hold, and everything under a team-wide hold", async () => {
    const key = put(staging(team, member), 3 * DAY);
    await placeHold(member);
    expect((await sweep()).staging).toBe(0);
    await h.admin.query(`DELETE FROM legal_holds`);
    await placeHold(null);
    expect((await sweep()).staging).toBe(0);
    expect(objects.keys()).toEqual([key]);
    await h.admin.query(`DELETE FROM legal_holds`);
    expect((await sweep()).staging).toBe(1);
  });

  it("ignores other shapes under incoming/ and other teams", async () => {
    const odd = put(`${PREFIX}teams/${team}/users/${user}/workspace/incoming/not-a-uuid`, 3 * DAY);
    const content = put(`${PREFIX}teams/${team}/users/${user}/workspace/${hex("c")}`, 3 * DAY);
    const foreign = put(staging(randomUUID(), user), 3 * DAY);
    expect(await sweep()).toEqual({ staging: 0, forks: 0, uploads: 0, skills: 0, evals: 0 });
    expect(objects.keys().sort()).toEqual([odd, content, foreign].sort());
  });
});

describe("staging objects of removed members (KOBE-243)", () => {
  it("sweeps a removed member's old staging objects, keeps young ones", async () => {
    const orphan = put(staging(team, ghost), 3 * DAY);
    const gone = put(staging(team, randomUUID()), 3 * DAY);
    const young = put(staging(team, ghost), 60_000);
    expect(await sweep()).toEqual({ staging: 2, forks: 0, uploads: 0, skills: 0, evals: 0 });
    expect(objects.keys()).toEqual([young]);
    expect(objects.deleted.sort()).toEqual([orphan, gone].sort());
  });

  it("keeps them under the user's hold or a team-wide hold", async () => {
    const key = put(staging(team, ghost), 3 * DAY);
    await placeHold(ghost);
    expect((await sweep()).staging).toBe(0);
    await h.admin.query(`DELETE FROM legal_holds`);
    await placeHold(null);
    expect((await sweep()).staging).toBe(0);
    expect(objects.keys()).toEqual([key]);
  });

  it("leaves non-uuid folders and other prefixes under users/ alone", async () => {
    const odd = put(
      `${PREFIX}teams/${team}/users/not-a-uuid/workspace/incoming/${randomUUID()}`,
      3 * DAY,
    );
    const other = put(`${PREFIX}teams/${team}/users/${ghost}/shared/${randomUUID()}`, 3 * DAY);
    expect(await sweep()).toEqual({ staging: 0, forks: 0, uploads: 0, skills: 0, evals: 0 });
    expect(objects.keys().sort()).toEqual([odd, other].sort());
  });
});

describe("personal skill bundles under a hold in another team (KOBE-773)", () => {
  const personal = (userId: string) =>
    `${PREFIX}skills/users/${userId}/${hex(randomUUID())}/${randomUUID()}`;
  const release = async (id: string) => {
    await h.admin.query(
      `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
              release_reason = 'done' WHERE id = $1`,
      [id, admin],
    );
    await h.admin.query(
      `UPDATE legal_holds SET status = 'released', released_by = $2, released_at = now()
        WHERE id = $1`,
      [id, user],
    );
  };

  it("keeps a member's uncommitted uploads while a hold names them in any team", async () => {
    const mine = put(personal(member), 3 * DAY);
    const theirs = put(personal(user), 3 * DAY);
    const hold = await placeHold(member, otherTeam);
    expect((await sweep()).skills).toBe(1);
    expect(objects.keys()).toEqual([mine]);
    expect(objects.deleted).toEqual([theirs]);
    await release(hold);
    expect((await sweep()).skills).toBe(1);
    expect(objects.keys()).toEqual([]);
  });

  it("a hold on another user, or a team-wide hold in a team they are not in, does not keep them", async () => {
    put(personal(member), 3 * DAY);
    await placeHold(ghost, otherTeam);
    await placeHold(null, otherTeam);
    expect((await sweep()).skills).toBe(1);
  });

  it("a team-wide hold in another team the user is a member of keeps them (review L6)", async () => {
    const mine = put(personal(member), 3 * DAY);
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [otherTeam, member],
    );
    try {
      const hold = await placeHold(null, otherTeam);
      expect((await sweep()).skills).toBe(0);
      expect(objects.keys()).toEqual([mine]);
      await release(hold);
      expect((await sweep()).skills).toBe(1);
    } finally {
      await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
        otherTeam,
        member,
      ]);
    }
  });

  it("a pending hold does not keep them", async () => {
    put(personal(member), 3 * DAY);
    await h.admin.query(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3)`,
      [otherTeam, member, admin],
    );
    expect((await sweep()).skills).toBe(1);
  });
});

describe("user folders (KOBE-740 review)", () => {
  it("are listed once per sweep, shared by staging and uploads", async () => {
    const root = `${PREFIX}teams/${team}/users/`;
    let folderListings = 0;
    const counting: BlobStore = {
      prefix: PREFIX,
      objects: Object.assign(Object.create(objects) as MemoryObjects, {
        list: (prefix: string, o?: Parameters<MemoryObjects["list"]>[1]) => {
          if (prefix === root && o?.delimiter === "/") folderListings++;
          return objects.list(prefix, o);
        },
      }),
    };
    put(staging(team, ghost), 3 * DAY);
    put(`${PREFIX}teams/${team}/users/${ghost}/uploads/${randomUUID()}`, 3 * DAY);
    expect(await sweepOrphanObjects(h.deps.database.db, team, counting)).toMatchObject({
      staging: 1,
      uploads: 1,
    });
    expect(folderListings).toBe(1);
  });
});

describe("a hanging delete (KOBE-243)", () => {
  it("is aborted and settled before the transaction, and so the hold lock, is released", async () => {
    const key = put(staging(), 3 * DAY);
    const events: string[] = [];
    const hanging: BlobStore = {
      prefix: PREFIX,
      deleteTimeoutMs: 50,
      objects: Object.assign(Object.create(objects) as MemoryObjects, {
        delete: (_keys: readonly string[], o?: { signal?: AbortSignal }) =>
          new Promise<void>((_res, rej) => {
            events.push("delete started");
            o?.signal?.addEventListener("abort", () => {
              events.push("delete aborted");
              setTimeout(() => {
                events.push("delete settled");
                rej(new Error("aborted"));
              }, 20);
            });
          }),
      }),
    };
    await expect(sweepOrphanObjects(h.deps.database.db, team, hanging)).rejects.toThrow(
      /timed out/,
    );
    events.push("lock released");
    expect(events).toEqual(["delete started", "delete aborted", "delete settled", "lock released"]);
    expect(objects.keys()).toEqual([key]);
    // Retry is idempotent: a working store deletes it.
    expect((await sweep()).staging).toBe(1);
  });
});

describe("fork-copied entry bodies", () => {
  it("deletes bodies of a thread without a row once old, keeps young ones", async () => {
    const id = randomUUID();
    const orphan = put(forkKey(id), 2 * DAY);
    const young = put(forkKey(id), 60_000);
    expect(await sweep()).toEqual({ staging: 0, forks: 1, uploads: 0, skills: 0, evals: 0 });
    expect(objects.keys()).toEqual([young]);
    expect(objects.deleted).toEqual([orphan]);
  });

  it("keeps bodies of a thread that has a row", async () => {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
      [team, id, user],
    );
    const key = put(forkKey(id), 3 * DAY);
    expect((await sweep()).forks).toBe(0);
    expect(objects.keys()).toEqual([key]);
  });

  it("keeps bodies queued for release and other object kinds in the tree", async () => {
    const id = randomUUID();
    const queued = put(forkKey(id), 3 * DAY);
    await h.admin.query(
      `INSERT INTO retention_blob_deletions (team_id, thread_id, key, owner_user_id) VALUES ($1, $2, $3, $4)`,
      [team, id, queued, user],
    );
    const artifact = put(`${PREFIX}teams/${team}/threads/${id}/artifacts/${hex("z")}`, 3 * DAY);
    expect((await sweep()).forks).toBe(0);
    expect(objects.keys().sort()).toEqual([queued, artifact].sort());
  });

  it("keeps everything while any hold is active in the team", async () => {
    const key = put(forkKey(), 3 * DAY);
    await placeHold(null);
    expect((await sweep()).forks).toBe(0);
    expect(objects.keys()).toEqual([key]);
  });
});

describe("boundaries and limits", () => {
  it("never lists or deletes outside the configured prefix", async () => {
    const id = randomUUID();
    const outside = [
      put(staging(team, user, "other/"), 3 * DAY),
      put(staging(team, user, ""), 3 * DAY),
      put(forkKey(id, team, "other/"), 3 * DAY),
      put(forkKey(id, team, ""), 3 * DAY),
    ];
    const inside = put(forkKey(id), 3 * DAY);
    expect((await sweep()).forks).toBe(1);
    expect(objects.keys().sort()).toEqual(outside.sort());
    expect(objects.deleted).toEqual([inside]);
  });

  it("caps deletions per sweep and finishes on the next", async () => {
    for (let i = 0; i < 5; i++) put(staging(), 3 * DAY);
    const db = h.deps.database.db;
    expect(await sweepOrphanObjects(db, team, store, { maxDeletions: 2 })).toEqual({
      staging: 2,
      forks: 0,
      uploads: 0,
      skills: 0,
      evals: 0,
    });
    expect(objects.keys()).toHaveLength(3);
    await sweepOrphanObjects(db, team, store, { maxDeletions: 10 });
    expect(objects.keys()).toEqual([]);
  });

  it("runs as a step of the retention pass, with counts only in its result", async () => {
    put(staging(), 3 * DAY);
    const res = await runRetentionPass({
      db: h.deps.database.db,
      blobs: store,
      logger: pino({ level: "silent" }),
    });
    expect(res.teams.find((t) => t.teamId === team)?.orphans).toEqual({
      staging: 1,
      forks: 0,
      uploads: 0,
      skills: 0,
      evals: 0,
    });
    expect(objects.keys()).toEqual([]);
  });
});
