import { describe, expect, it } from "vitest";
import { runRetentionPass } from "./index.js";
import {
  h,
  objects,
  log,
  ids,
  as,
  team,
  other,
  DAY,
  ago,
  thread,
  endedRun,
  key,
  named,
  forkLinks,
  threadIds,
  audits,
  placeHold,
  releaseHold,
  pass,
  setPeriod,
  useRetentionHarness,
} from "./retention.test-helpers.js";

useRetentionHarness();

describe("retention settings (D6, D8; 7-day grace: user decision 2026-10-04)", () => {
  it("defaults to forever; members read it, only team admins change it, within the site maximum", async () => {
    const read = await as.bob.get("/v1/team/retention");
    expect(read.json).toEqual({
      period: "forever",
      maximum: "forever",
      effective: "forever",
      pending: null,
      upcoming: null,
      allowed: ["30d", "90d", "1y", "forever"],
    });
    expect((await as.bob.put("/v1/team/retention", { period: "30d" })).status).toBe(403);
    expect((await as.bob.delete("/v1/team/retention/pending")).status).toBe(403);
    expect((await as.alice.put("/v1/team/retention", { period: "7d" })).status).toBe(400);
    expect((await as.alice.put("/v1/site/retention", { maximum: "90d" })).status).toBe(403);
  });

  it("schedules a shortening 7 days out: banner for members, email to admins (count only), cancellable", async () => {
    await thread({ owner: ids.bob, title: "Secret plan", activity: ago(400) });
    await thread({ owner: ids.carol, title: "Other secret", activity: ago(380) });
    await thread({ owner: ids.carol, title: "Recent", activity: ago(5) });
    // In Trash: not counted (Trash empties itself after 30 days anyway).
    await thread({ owner: ids.carol, title: "Trashed", activity: ago(390), deletedAt: ago(1) });
    h.mailer.sent.length = 0;
    const before = Date.now();
    const set = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(set.status).toBe(200);
    const effectiveAt = new Date(String(set.json.pending?.effectiveAt)).getTime();
    expect(effectiveAt - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
    expect(effectiveAt - before).toBeLessThanOrEqual(7 * DAY + 60_000);
    // Not in force yet: the job still keeps everything.
    expect(set.json).toMatchObject({ period: "1y", effective: "forever" });
    const banner = (await as.bob.get("/v1/team/retention")).json;
    expect(banner.upcoming).toEqual({ period: "1y", effectiveAt: set.json.pending.effectiveAt });
    await pass();
    expect(await threadIds()).toHaveLength(4);

    expect((await audits("retention.policy.changed")).at(-1)).toMatchObject({
      actor_id: ids.alice,
      target: { period: "1y", previous: "forever", effectiveAt: set.json.pending.effectiveAt },
    });
    await h.mailer.settle();
    const [mail, ...more] = h.mailer.to("alice@ret.test");
    expect(more).toEqual([]);
    expect(mail?.subject).toMatch(/conversations older than 1 year will be deleted/);
    expect(mail?.text).toContain("Today, 2 conversations in the team would be deleted");
    expect(mail?.text).toContain("not counting conversations in Trash");
    expect(mail?.text).not.toMatch(/Secret plan|Other secret|Recent|Trashed/);
    expect(h.mailer.to("bob@ret.test")).toEqual([]);
    expect((await audits("retention.shortening_notified")).at(-1)?.target).toMatchObject({
      period: "1y",
      threads: 2,
      recipients: 1,
    });

    // Cancel during the grace period: reverts to what applies, audited.
    const cancelled = await as.alice.delete("/v1/team/retention/pending");
    expect(cancelled.json).toMatchObject({ period: "forever", pending: null, upcoming: null });
    expect((await audits("retention.policy.change_cancelled")).at(-1)).toMatchObject({
      actor_id: ids.alice,
      target: { period: "1y", kept: "forever" },
    });
    expect((await as.alice.delete("/v1/team/retention/pending")).status).toBe(404);
  });

  it("applies the shortening once its date has come; lengthening applies at once", async () => {
    const old = await thread({ owner: ids.bob, activity: ago(40) });
    await as.alice.put("/v1/team/retention", { period: "30d" });
    // The grace period ends (as if 7 days passed).
    await h.admin.query(`UPDATE team_retention SET pending_at = now() - interval '1 minute'`);
    expect((await as.bob.get("/v1/team/retention")).json).toMatchObject({
      period: "30d",
      effective: "30d",
      pending: null,
    });
    await pass();
    expect(await threadIds()).not.toContain(old);
    // Longer: no grace, no email.
    h.mailer.sent.length = 0;
    const longer = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(longer.json).toMatchObject({ period: "1y", effective: "1y", pending: null });
    await h.mailer.settle();
    expect(h.mailer.sent).toEqual([]);
    expect((await audits("retention.policy.changed")).at(-1)?.target).toEqual({
      period: "1y",
      previous: "30d",
    });
  });

  it("lowers the site maximum after the grace period, emailing the teams it shortens; cancellable", async () => {
    await setPeriod(other, "30d");
    h.mailer.sent.length = 0;
    const max = await as.owner.put("/v1/site/retention", { maximum: "90d" });
    expect(max.json).toMatchObject({
      maximum: "90d",
      applied: "forever",
      pending: { maximum: "90d" },
    });
    expect((await audits("retention.maximum.changed", null)).at(-1)?.target).toMatchObject({
      maximum: "90d",
      previous: "forever",
      effectiveAt: max.json.pending.effectiveAt,
    });
    // Finance (forever) is shortened, so its admin is told; Legal (30 days) is not affected.
    const view = (await as.bob.get("/v1/team/retention")).json;
    expect(view).toMatchObject({
      period: "forever",
      maximum: "90d",
      effective: "forever",
      upcoming: { period: "90d", effectiveAt: max.json.pending.effectiveAt },
      allowed: ["30d", "90d"],
    });
    await h.mailer.settle();
    expect(h.mailer.to("alice@ret.test")).toHaveLength(1);
    expect((await audits("retention.shortening_notified", other)).length).toBe(0);
    // A team can't choose above the coming maximum.
    const over = await as.alice.put("/v1/team/retention", { period: "1y" });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe("exceeds_maximum");

    // The status admins read carries the pause flag (KOBE-243); the harness runs unpaused.
    expect((await as.owner.get("/v1/site/retention")).json).toMatchObject({ paused: false });

    const cancelled = await as.owner.delete("/v1/site/retention/pending");
    expect(cancelled.json).toEqual({ maximum: "forever", applied: "forever", pending: null });
    expect((await audits("retention.maximum.change_cancelled", null)).at(-1)?.target).toEqual({
      maximum: "90d",
      kept: "forever",
    });
    expect((await as.bob.get("/v1/team/retention")).json.upcoming).toBeNull();
  });
});

describe("legal hold suspends every purge (KOBE-17 contract)", () => {
  it("skips a held user's expired threads, Trash, compaction and blobs; others' go; release resumes", async () => {
    await setPeriod(team, "30d");
    const held = await thread({ owner: ids.bob, activity: ago(40), blobKeys: [key("held")] });
    const heldTrash = await thread({ owner: ids.bob, activity: ago(40), deletedAt: ago(31) });
    const heldRun = await endedRun(held, 8);
    const free = await thread({ owner: ids.carol, activity: ago(40), blobKeys: [key("free")] });
    const hold = await placeHold(team, ids.bob);

    await pass();
    expect(await threadIds()).toEqual([held, heldTrash].sort());
    expect(objects.keys()).toEqual([named("held")]);
    expect(
      (
        await h.admin.query(`SELECT 1 FROM run_events WHERE team_id = $1 AND run_id = $2`, [
          team,
          heldRun,
        ])
      ).rowCount,
    ).toBe(3);
    expect(free).toBeTruthy();

    await releaseHold(hold);
    await pass();
    expect(await threadIds()).toEqual([]);
    expect(objects.keys()).toEqual([]);
  });

  it("a team-wide hold keeps everything in the team", async () => {
    await setPeriod(team, "30d");
    const a = await thread({ owner: ids.bob, activity: ago(40) });
    const b = await thread({ owner: ids.carol, activity: ago(40), deletedAt: ago(45) });
    const hold = await placeHold(team, null);
    await pass();
    expect(await threadIds()).toEqual([a, b].sort());
    await releaseHold(hold);
  });

  it("keeps the bytes when a hold is placed after the rows were purged", async () => {
    await setPeriod(team, "30d");
    await thread({ owner: ids.bob, activity: ago(40), blobKeys: [key("late")] });
    // Purge the rows but not the blobs (no object store for this pass).
    await runRetentionPass({ db: h.deps.database.db, logger: log });
    expect(await threadIds()).toEqual([]);
    const hold = await placeHold(team, ids.bob);
    await pass();
    expect(objects.keys()).toEqual([named("late")]);
    await releaseHold(hold);
    await pass();
    expect(objects.keys()).toEqual([]);
  });
});

describe("Delete forever (D18: the owner only)", () => {
  it("purges the owner's thread from Trash at once, with its blobs; nobody else can", async () => {
    const t = await thread({ owner: ids.bob, deletedAt: new Date(), blobKeys: [key("gone")] });
    await endedRun(t, 1);
    // Not the owner: the team admin and another member both get "not found".
    expect((await as.alice.post(`/v1/threads/${t}/purge`)).status).toBe(404);
    expect((await as.carol.post(`/v1/threads/${t}/purge`)).status).toBe(404);
    const res = await as.bob.post(`/v1/threads/${t}/purge`);
    expect(res.status).toBe(204);
    expect(await threadIds()).toEqual([]);
    await h.deps.background.idle();
    expect(objects.keys()).toEqual([]);
    expect((await audits("thread.purge_requested")).at(-1)).toMatchObject({
      actor_id: ids.bob,
      target: { threadId: t },
    });
    expect((await audits("thread.purged")).at(-1)?.target).toEqual({
      threadId: t,
      entries: 2,
      runs: 1,
      events: 3,
      blobs: 1,
    });
  });

  it("keeps the thread's forks, clearing only their link (KOBE-215)", async () => {
    const source = await thread({ owner: ids.bob, deletedAt: new Date() });
    const fork = await thread({ owner: ids.carol, forkOf: source });
    expect((await as.bob.post(`/v1/threads/${source}/purge`)).status).toBe(204);
    expect(await threadIds()).toEqual([fork]);
    expect(await forkLinks()).toEqual([
      { team_id: team, forked_from_thread_id: null, forked_at_entry_id: "e1" },
    ]);
  });

  it("refuses a thread that is not in Trash, or a thread of another team", async () => {
    const live = await thread({ owner: ids.bob });
    const res = await as.bob.post(`/v1/threads/${live}/purge`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("not_in_trash");
    const elsewhere = await thread({ teamId: other, owner: ids.bob, deletedAt: new Date() });
    expect((await as.bob.post(`/v1/threads/${elsewhere}/purge`)).status).toBe(404);
    expect(await threadIds(other)).toEqual([elsewhere]);
  });

  it("under a hold: the thread leaves Trash for the user but is kept until the hold is released", async () => {
    const t = await thread({ owner: ids.bob, deletedAt: new Date() });
    const hold = await placeHold(team, ids.bob);
    expect((await as.bob.post(`/v1/threads/${t}/purge`)).status).toBe(204);
    expect(await threadIds()).toEqual([t]);
    expect((await as.bob.get("/v1/threads/trash")).json.threads).toEqual([]);
    expect((await as.bob.post(`/v1/threads/${t}/restore`)).status).toBe(404);
    expect((await audits("thread.purged")).some((a) => a.target.threadId === t)).toBe(false);
    await releaseHold(hold);
    await pass();
    expect(await threadIds()).toEqual([]);
  });
});
