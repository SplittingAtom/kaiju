import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  h,
  ids,
  as,
  team,
  SCIM,
  deactivateUser,
  ago,
  pass,
  ws,
  site,
  portable,
  versionsOf,
  audits,
  sum,
  setPeriod,
  placeHold,
  placeSiteHold,
  clearHolds,
  exists,
  useSemanticMemoryRetentionHarness,
} from "./semantic-memory-retention.test-helpers.js";

useSemanticMemoryRetentionHarness();

describe("Workspace sweep (ac-1)", () => {
  it("purges archived and superseded items past the window, never a live one", async () => {
    await setPeriod("30d");
    const archived = await ws({
      owner: ids.alice,
      status: "archived",
      updated: 40,
      versions: [90, 50],
    });
    const recent = await ws({ owner: ids.alice, status: "archived", updated: 10 });
    const live = await ws({ updated: 400, versions: [400] });
    // A superseded chain: `older` names `successor`, which is archived too; both go.
    const successor = await ws({ status: "archived", updated: 60 });
    const older = await ws({ supersededBy: successor, updated: 70 });
    // A superseded item whose successor is live: it goes, the successor stays.
    const current = await ws({ updated: 1 });
    const replaced = await ws({ supersededBy: current, updated: 45 });
    await pass();
    for (const gone of [archived, successor, older, replaced])
      expect(await exists("semantic_memory_items", gone)).toBe(false);
    expect(await versionsOf("ws", archived)).toEqual([]);
    for (const kept of [recent, live, current])
      expect(await exists("semantic_memory_items", kept)).toBe(true);
    const rows = await audits("retention.semantic_memory_purged");
    expect(rows.every((r) => r.target.reason === "retention")).toBe(true);
    expect([sum(rows, "items"), sum(rows, "versions")]).toEqual([4, 5]);
  });

  it("purges versions replaced longer ago than the window; the current one and recent history stay", async () => {
    await setPeriod("30d");
    const item = await ws({ owner: ids.alice, versions: [100, 60, 5] });
    const old = await ws({ versions: [500] });
    await pass();
    expect(await versionsOf("ws", item)).toEqual([2, 3]);
    expect(await versionsOf("ws", old)).toEqual([1]);
  });

  it("purges nothing by age while the Workspace keeps conversations forever", async () => {
    const archived = await ws({ status: "archived", updated: 900, versions: [999, 950] });
    await pass();
    expect(await versionsOf("ws", archived)).toEqual([1, 2]);
  });

  it("skips a held owner's items, and with a Workspace-wide hold every item", async () => {
    await setPeriod("30d");
    await placeHold(ids.bob);
    const bobs = await ws({ owner: ids.bob, status: "archived", updated: 90, versions: [100, 60] });
    const bobVersions = await ws({ owner: ids.bob, versions: [100, 60, 5] });
    const alices = await ws({ owner: ids.alice, status: "archived", updated: 90 });
    await pass();
    expect(await versionsOf("ws", bobs)).toEqual([1, 2]);
    expect(await versionsOf("ws", bobVersions)).toEqual([1, 2, 3]);
    expect(await exists("semantic_memory_items", alices)).toBe(false);

    await placeHold(null);
    const shared = await ws({ status: "archived", updated: 90 });
    const carols = await ws({ owner: ids.carol, versions: [100, 60, 5] });
    await pass();
    expect(await exists("semantic_memory_items", shared)).toBe(true);
    expect(await versionsOf("ws", carols)).toEqual([1, 2, 3]);
  });

  it("takes the hold lock first: a hold approved while the sweep waits wins", async () => {
    await setPeriod("30d");
    const item = await ws({ owner: ids.alice, status: "archived", updated: 90 });
    const client = new pg.Client({ connectionString: h.adminUrl });
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0))");
    const sweep = pass();
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'mid-sweep', $3)
       RETURNING id`,
      [team, ids.alice, ids.admin],
    );
    await client.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
      rows[0]?.id,
      ids.owner,
    ]);
    await client.query("COMMIT");
    await client.end();
    await sweep;
    expect(await exists("semantic_memory_items", item)).toBe(true);
  });

  it("drops evidence with its source conversation; a held item keeps it until released", async () => {
    const thread = randomUUID();
    await h.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, deleted_at) VALUES ($1, $2, $3, 'src', $4)`,
      [team, thread, ids.alice, ago(31)],
    );
    const alices = await ws({ owner: ids.alice, sourceThread: thread, versions: [10, 2] });
    const bobs = await ws({ owner: ids.bob, sourceThread: thread });
    await placeHold(ids.bob);
    await pass();
    expect(await exists("threads", thread)).toBe(false);
    const read = async (id: string) =>
      (
        await h.admin.query<{
          statement: string;
          evidence: unknown;
          src: string | null;
          e: string[] | null;
        }>(
          `SELECT statement, evidence, source_thread_id AS src, source_entry_ids AS e
             FROM semantic_memory_item_versions WHERE item_id = $1 ORDER BY version`,
          [id],
        )
      ).rows;
    // The memory stays ("source deleted"); only the quote and links go.
    expect(await read(alices)).toEqual([
      { statement: "statement 1", evidence: null, src: null, e: null },
      { statement: "statement 2", evidence: null, src: null, e: null },
    ]);
    expect((await read(bobs))[0]?.src).toBe(thread);
    await clearHolds();
    await pass();
    expect((await read(bobs))[0]).toEqual({
      statement: "statement 1",
      evidence: null,
      src: null,
      e: null,
    });
    expect(sum(await audits("retention.semantic_memory_purged"), "scrubbed")).toBe(1);
  });
});

describe("Site and portable sweep (ac-1, ac-5)", () => {
  it("purges archived Site items and old versions past the Site window", async () => {
    const archived = await site({ status: "archived", updated: 40, versions: [60, 45] });
    const recent = await site({ status: "archived", updated: 20 });
    const live = await site({ versions: [100, 50, 5] });
    await pass();
    expect(await exists("site_memory_items", archived)).toBe(false);
    expect(await exists("site_memory_items", recent)).toBe(true);
    expect(await versionsOf("site", live)).toEqual([2, 3]);
    const rows = await audits("retention.site_memory_purged");
    expect(rows.map((r) => r.target)).toContainEqual({
      lane: "site",
      reason: "retention",
      items: 1,
      versions: 2,
      kept: 0,
    });
  });

  it("deletes no Site or portable memory while a Site-wide hold is in force (N1)", async () => {
    const archived = await site({ status: "archived", updated: 90 });
    const live = await site({ versions: [100, 50, 5] });
    const pArchived = await portable(ids.finn, { status: "archived", updated: 90 });
    const pLive = await portable(ids.finn, { versions: [100, 50, 5] });
    await placeSiteHold();
    await pass();
    expect(await exists("site_memory_items", archived)).toBe(true);
    expect(await versionsOf("site", live)).toEqual([1, 2, 3]);
    expect(await exists("portable_memory_items", pArchived)).toBe(true);
    expect(await versionsOf("portable", pLive)).toEqual([1, 2, 3]);
    await clearHolds();
    await pass();
    expect(await exists("site_memory_items", archived)).toBe(false);
    expect(await exists("portable_memory_items", pArchived)).toBe(false);
    expect(await versionsOf("portable", pLive)).toEqual([2, 3]);
  });

  it("keeps the Site items a held person wrote", async () => {
    await placeHold(ids.carol);
    const carols = await site({ status: "archived", updated: 90, actor: ids.carol });
    const others = await site({ status: "archived", updated: 90 });
    await pass();
    expect(await exists("site_memory_items", carols)).toBe(true);
    expect(await exists("site_memory_items", others)).toBe(false);
  });

  it("purges archived portable items and old versions; a held owner keeps theirs", async () => {
    const archived = await portable(ids.dora, { status: "archived", updated: 40 });
    const live = await portable(ids.dora, { versions: [100, 50, 5] });
    const held = await portable(ids.bob, { status: "archived", updated: 90 });
    await placeHold(ids.bob);
    await pass();
    expect(await exists("portable_memory_items", archived)).toBe(false);
    expect(await versionsOf("portable", live)).toEqual([2, 3]);
    expect(await exists("portable_memory_items", held)).toBe(true);
  });
});

describe("Workspace-wide holds and portable items (Q2)", () => {
  it("freeze only the portable items of members of the held Workspace", async () => {
    // finn is in no Workspace; dora is a member of the held one.
    const doras = await portable(ids.dora, { status: "archived", updated: 90 });
    const finns = await portable(ids.finn, { status: "archived", updated: 90 });
    const finnVersions = await portable(ids.finn, { versions: [100, 50, 5] });
    await placeHold(null);
    await pass();
    expect(await exists("portable_memory_items", doras)).toBe(true);
    expect(await exists("portable_memory_items", finns)).toBe(false);
    expect(await versionsOf("portable", finnVersions)).toEqual([2, 3]);
  });

  it("refuse an admin purge only for members of the held Workspace", async () => {
    await portable(ids.dora);
    await portable(ids.finn);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await deactivateUser(h.deps.database.db, ids.finn, { via: SCIM });
    await placeHold(null);
    const dora = await as.admin.post(`/v1/site/users/${ids.dora}/portable-memory/purge`, {
      confirmEmail: "dora@smret.test",
    });
    expect([dora.status, dora.json.code]).toEqual([409, "legal_hold"]);
    const finn = await as.admin.post(`/v1/site/users/${ids.finn}/portable-memory/purge`, {
      confirmEmail: "finn@smret.test",
    });
    expect(finn.status, JSON.stringify(finn.json)).toBe(200);
    expect(finn.json).toMatchObject({ purged: 1, kept: 0 });
  });
});

describe("stale (KOBE-386, threshold from KOBE-381)", () => {
  it("flags active items neither changed nor dated within the threshold, and filters on it", async () => {
    const old = await ws({ owner: ids.alice, updated: 100, versions: [100] });
    const fresh = await ws({ owner: ids.alice, updated: 10, versions: [10] });
    const dated = await ws({
      owner: ids.alice,
      updated: 100,
      versions: [100],
      asOf: ago(5).slice(0, 10),
    });
    const alice = await h.signIn("alice@smret.test");
    await alice.put("/v1/me/teams/active", { teamId: team });
    alice.team = team;
    const ITEMS = "/v1/memory/semantic/items";
    const list = await alice.get(`${ITEMS}?scope=user`);
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const flags = Object.fromEntries(
      (list.json.items as { id: string; stale: boolean }[]).map((i) => [i.id, i.stale]),
    );
    expect(flags).toEqual({ [old]: true, [fresh]: false, [dated]: false });
    const only = await alice.get(`${ITEMS}?scope=user&stale=true`);
    expect((only.json.items as { id: string }[]).map((i) => i.id)).toEqual([old]);
    const not = await alice.get(`${ITEMS}?scope=user&stale=false`);
    expect((not.json.items as { id: string }[]).map((i) => i.id).sort()).toEqual(
      [fresh, dated].sort(),
    );
    expect((await alice.get(`${ITEMS}/user/${old}`)).json.stale).toBe(true);
    // The threshold is the Site setting.
    await h.admin.query(`UPDATE site_settings SET value = $1 WHERE key = 'memory.settings'`, [
      JSON.stringify({ retention_days: 30, stale_after_days: 7 }),
    ]);
    expect((await alice.get(`${ITEMS}/user/${fresh}`)).json.stale).toBe(true);
  });
});
