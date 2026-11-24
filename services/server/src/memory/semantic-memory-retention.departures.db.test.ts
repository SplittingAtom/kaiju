import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOffboarding } from "../offboarding/index.js";
import { purgeDeparted } from "../offboarding/purge.js";
import {
  h,
  log,
  ids,
  as,
  team,
  SCIM,
  CONFIRM_DORA,
  asScim,
  deactivateUser,
  reactivateUserIfVia,
  pass,
  offboardingCtx,
  ws,
  portable,
  versionsOf,
  audits,
  placeHold,
  placeSiteHold,
  clearHolds,
  member,
  exists,
  useSemanticMemoryRetentionHarness,
} from "./semantic-memory-retention.test-helpers.js";

useSemanticMemoryRetentionHarness();

describe("offboarding (ac-2)", () => {
  async function departed(userId: string, retainDays = -1): Promise<void> {
    await member(userId, false);
    await h.admin.query(
      `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, retain_until)
       VALUES ($1, $2, $3, 'destroyed', NULL, now() + make_interval(days => $4))`,
      [team, userId, randomUUID(), retainDays],
    );
  }

  it("purges a departed member's personal items after 30 days; Workspace and portable items stay", async () => {
    const mine = await ws({ owner: ids.bob, versions: [5, 4] });
    const archived = await ws({ owner: ids.bob, status: "archived" });
    const chain = await ws({ owner: ids.bob, supersededBy: mine });
    const shared = await ws({ actor: ids.bob });
    const alices = await ws({ owner: ids.alice });
    const pref = await portable(ids.bob);
    await departed(ids.bob);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "deleted",
    );
    for (const gone of [mine, archived, chain])
      expect(await exists("semantic_memory_items", gone)).toBe(false);
    // "Former member": the Workspace item they wrote stays, as do others' and their portable ones.
    expect(await versionsOf("ws", shared)).toEqual([1]);
    expect(await exists("semantic_memory_items", alices)).toBe(true);
    expect(await exists("portable_memory_items", pref)).toBe(true);
    expect((await audits("retention.semantic_memory_purged")).map((r) => r.target)).toEqual([
      { reason: "offboarding", userId: ids.bob, items: 3, versions: 4, scrubbed: 0 },
    ]);
  });

  it("keeps them inside the 30 days, under a hold, and when the member came back", async () => {
    const mine = await ws({ owner: ids.bob });
    await departed(ids.bob, 10);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "not_due",
    );
    await h.admin.query(
      `UPDATE sandboxes SET retain_until = now() - interval '1 minute' WHERE user_id = $1`,
      [ids.bob],
    );
    await placeHold(ids.bob);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "held",
    );
    await clearHolds();
    await member(ids.bob, true);
    await purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob });
    expect(await exists("semantic_memory_items", mine)).toBe(true);
  });

  it("starts the 30 days for a departed owner who never had a sandbox", async () => {
    const mine = await ws({ owner: ids.erin });
    await member(ids.erin, false);
    const offboarding = createOffboarding({ db: h.deps.database.db, blobs: undefined, log });
    await offboarding.sweep();
    const row = await h.admin.query<{ state: string; days: number }>(
      `SELECT state, round(extract(epoch FROM retain_until - now()) / 86400)::int AS days
         FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
      [team, ids.erin],
    );
    expect(row.rows).toEqual([{ state: "destroyed", days: 30 }]);
    expect(await exists("semantic_memory_items", mine)).toBe(true);
    await h.admin.query(
      `UPDATE sandboxes SET retain_until = now() - interval '1 minute' WHERE user_id = $1`,
      [ids.erin],
    );
    await offboarding.sweep();
    expect(await exists("semantic_memory_items", mine)).toBe(false);
  });
});

describe("a second departure (review H1)", () => {
  const retainDays = async (userId: string) =>
    (
      await h.admin.query<{ days: number | null }>(
        `SELECT round(extract(epoch FROM retain_until - now()) / 86400)::int AS days
           FROM sandboxes WHERE team_id = $1 AND user_id = $2`,
        [team, userId],
      )
    ).rows[0]?.days ?? null;
  const offboarding = () => createOffboarding({ db: h.deps.database.db, blobs: undefined, log });

  it("leave, return, leave again: the 30 days start again at the second departure", async () => {
    const mine = await ws({ owner: ids.bob });
    await member(ids.bob, false);
    await offboarding().offboardMember(team, ids.bob, "member_removed");
    expect(await retainDays(ids.bob)).toBe(30);
    // Day 10: back (no sandbox woken); the sweep's backstop reopens the record.
    await h.admin.query(
      `UPDATE sandboxes SET retain_until = now() + interval '20 days' WHERE user_id = $1`,
      [ids.bob],
    );
    await member(ids.bob, true);
    await offboarding().sweep();
    expect(await retainDays(ids.bob)).toBeNull();
    // Day 29: gone again: a fresh 30 days, nothing due tomorrow.
    await member(ids.bob, false);
    await offboarding().offboardMember(team, ids.bob, "member_removed");
    expect(await retainDays(ids.bob)).toBe(30);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "not_due",
    );
    expect(await exists("semantic_memory_items", mine)).toBe(true);
  });

  it("a rejoin through an invitation path reopens the record at once", async () => {
    await ws({ owner: ids.bob });
    await member(ids.bob, false);
    await offboarding().offboardMember(team, ids.bob, "member_removed");
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, ids.bob],
    );
    const { withTeam } = await import("@kaiju/db");
    const { reopenRetentionInTx } = await import("../offboarding/reopen.js");
    await withTeam(h.deps.database.db, team, (tx) => reopenRetentionInTx(tx, team, [ids.bob]));
    expect(await retainDays(ids.bob)).toBeNull();
  });

  it("deactivate, reactivate, deactivate: the reactivation reopens and the next deactivation starts afresh", async () => {
    await ws({ owner: ids.erin });
    await deactivateUser(h.deps.database.db, ids.erin, { via: SCIM });
    await asScim(() => h.deps.lifecycle.emit("deactivated", ids.erin));
    await offboarding().sweep(); // no sandbox: the sweep records the window
    expect(await retainDays(ids.erin)).toBe(30);
    await h.admin.query(
      `UPDATE sandboxes SET retain_until = now() + interval '1 day' WHERE user_id = $1`,
      [ids.erin],
    );
    await reactivateUserIfVia(h.deps.database.db, ids.erin, SCIM);
    await asScim(() => h.deps.lifecycle.emit("reactivated", ids.erin));
    expect(await retainDays(ids.erin)).toBeNull();
    await deactivateUser(h.deps.database.db, ids.erin, { via: SCIM });
    await asScim(() => h.deps.lifecycle.emit("deactivated", ids.erin));
    expect(await retainDays(ids.erin)).toBe(30);
  });
});

describe("deactivation (ac-3)", () => {
  const snapshot = async (owner: string) =>
    (
      await h.admin.query(
        `SELECT i.id, i.status, i.pinned, i.tags, i.current_version, i.updated_at,
                v.version, v.statement, v.created_at
           FROM portable_memory_items i JOIN portable_memory_item_versions v ON v.item_id = i.id
          WHERE i.owner_user_id = $1 ORDER BY i.id, v.version`,
        [owner],
      )
    ).rows;

  it("keeps portable items through SCIM deactivation and restores them unchanged on reactivation by the same source", async () => {
    await portable(ids.dora, { versions: [10, 2] });
    await portable(ids.dora, { status: "archived", updated: 5 });
    const before = await snapshot(ids.dora);
    expect(before).toHaveLength(3);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await asScim(() => h.deps.lifecycle.emit("deactivated", ids.dora));
    await createOffboarding({ db: h.deps.database.db, blobs: undefined, log }).sweep();
    await pass();
    expect(await snapshot(ids.dora)).toEqual(before);
    // Only the source that deactivated reactivates (SSO11).
    await expect(reactivateUserIfVia(h.deps.database.db, ids.dora, "admin")).resolves.toBe(
      "refused",
    );
    await expect(reactivateUserIfVia(h.deps.database.db, ids.dora, SCIM)).resolves.toBe(
      "reactivated",
    );
    expect(await snapshot(ids.dora)).toEqual(before);
    const dora = await h.signIn("dora@smret.test");
    const list = await dora.get("/v1/memory/semantic/items?scope=portable");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.items).toHaveLength(1);
  });

  it("a JIT duplicate account starts with no portable memories", async () => {
    await portable(ids.dora);
    await h.createUser("dora.sso@smret.test");
    const twin = await h.signIn("dora.sso@smret.test");
    const list = await twin.get("/v1/memory/semantic/items?scope=portable");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.items).toEqual([]);
    expect(await snapshot(ids.dora)).toHaveLength(1);
  });

  it("purges portable items only on a site admin's purge of a deactivated account, never under a hold", async () => {
    const a = await portable(ids.dora, { versions: [3, 2] });
    const b = await portable(ids.dora, { supersededBy: a });
    const path = `/v1/site/users/${ids.dora}/portable-memory/purge`;
    const active = await as.admin.post(path, CONFIRM_DORA);
    expect([active.status, active.json.code]).toEqual([409, "user_active"]);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await placeHold(ids.dora);
    const held = await as.admin.post(path, CONFIRM_DORA);
    expect([held.status, held.json.code]).toEqual([409, "legal_hold"]);
    expect(await snapshot(ids.dora)).toHaveLength(3);
    await clearHolds();
    const done = await as.admin.post(path, CONFIRM_DORA);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ purged: 2, kept: 0, remaining: 0 });
    expect(await exists("portable_memory_items", a)).toBe(false);
    expect(await exists("portable_memory_items", b)).toBe(false);
    // One audit row per batch: the item superseding the other went in the first, as the admin.
    const rows = await audits("retention.site_memory_purged");
    expect(rows.every((r) => r.actor_id === ids.admin)).toBe(true);
    expect(rows.map((r) => r.target)).toEqual([
      { lane: "portable", reason: "offboarding", items: 1, versions: 1, kept: 0, userId: ids.dora },
      { lane: "portable", reason: "offboarding", items: 1, versions: 2, kept: 0, userId: ids.dora },
    ]);
  });

  it("needs the person's email typed to confirm (one admin is enough, L3)", async () => {
    await portable(ids.dora);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    const path = `/v1/site/users/${ids.dora}/portable-memory/purge`;
    expect((await as.admin.post(path)).status).toBe(400);
    const wrong = await as.admin.post(path, { confirmEmail: "finn@smret.test" });
    expect([wrong.status, wrong.json.code]).toEqual([400, "confirmation_mismatch"]);
    expect(await snapshot(ids.dora)).toHaveLength(1);
    expect(await audits("retention.site_memory_purged")).toEqual([]);
  });

  it("is refused while a Site-wide hold is in force (L1)", async () => {
    await portable(ids.dora);
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    await placeSiteHold();
    const path = `/v1/site/users/${ids.dora}/portable-memory/purge`;
    const held = await as.admin.post(path, CONFIRM_DORA);
    expect([held.status, held.json.code]).toEqual([409, "legal_hold"]);
    expect(await snapshot(ids.dora)).toHaveLength(1);
    await clearHolds();
    expect((await as.admin.post(path, CONFIRM_DORA)).json).toMatchObject({ purged: 1 });
  });

  it("audits a purge that found nothing (L2) and keeps a supersede cycle as kept (L5)", async () => {
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    const path = `/v1/site/users/${ids.dora}/portable-memory/purge`;
    expect((await as.admin.post(path, CONFIRM_DORA)).json).toMatchObject({
      purged: 0,
      kept: 0,
      remaining: 0,
    });
    const a = await portable(ids.dora);
    const b = await portable(ids.dora, { supersededBy: a });
    await h.admin.query(
      `UPDATE portable_memory_items SET status = 'superseded', superseded_by = $2 WHERE id = $1`,
      [a, b],
    );
    expect((await as.admin.post(path, CONFIRM_DORA)).json).toMatchObject({
      purged: 0,
      kept: 2,
      remaining: 0,
    });
    const rows = (await audits("retention.site_memory_purged")).map((r) => r.target);
    expect(rows).toEqual([
      { lane: "portable", reason: "offboarding", items: 0, versions: 0, kept: 0, userId: ids.dora },
      { lane: "portable", reason: "offboarding", items: 0, versions: 0, kept: 2, userId: ids.dora },
    ]);
  });

  it("purges in bounded batches, each audited (M2)", async () => {
    await h.admin.query(
      `WITH i AS (
         INSERT INTO portable_memory_items (id, owner_user_id, kind, status, current_version, updated_at)
         SELECT gen_random_uuid(), $1, 'preference', 'archived', 1, now() FROM generate_series(1, 250)
         RETURNING id)
       INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
       SELECT id, 1, 'bulk', $1, 'user' FROM i`,
      [ids.dora],
    );
    await deactivateUser(h.deps.database.db, ids.dora, { via: SCIM });
    const done = await as.admin.post(
      `/v1/site/users/${ids.dora}/portable-memory/purge`,
      CONFIRM_DORA,
    );
    expect(done.json).toMatchObject({ purged: 250, kept: 0, remaining: 0 });
    const rows = (await audits("retention.site_memory_purged")).map((r) => r.target.items);
    expect(rows).toEqual([100, 100, 50]);
  });
});
