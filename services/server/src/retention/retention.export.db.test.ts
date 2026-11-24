import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { StillAMemberError, purgeDepartedMember } from "./index.js";
import {
  h,
  blobs,
  ids,
  as,
  team,
  other,
  ago,
  member,
  thread,
  key,
  named,
  threadIds,
  audits,
  placeHold,
  releaseHold,
  download,
  useRetentionHarness,
} from "./retention.test-helpers.js";

useRetentionHarness();

describe("export (D18)", () => {
  it("contains only the user's threads in the active team, as Pi JSONL and Markdown", async () => {
    const carols = await thread({
      owner: ids.carol,
      title: "Carol secret",
      blobKeys: [key("carol-secret")],
    });
    const mine = await thread({ owner: ids.bob, title: "Budget 2027", entries: 4 });
    const trashed = await thread({ owner: ids.bob, title: "Old plan", deletedAt: ago(2) });
    // Its second entry names Carol's object: never read (not in this thread's tree).
    const offloaded = await thread({
      owner: ids.bob,
      title: "Big",
      blobKeys: [key("big"), named("carol-secret")],
    });
    const otherTeam = await thread({ teamId: other, owner: ids.bob, title: "Legal matter" });
    const expired = await thread({ owner: ids.bob, title: "Awaiting purge", deletedAt: ago(31) });

    const res = await download(as.bob, `/v1/threads/export?team=${team}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="kaiju-finance-/);
    const files = unzipSync(res.bytes);
    const names = Object.keys(files).sort();
    const sessions = names.filter((n) => n.startsWith("sessions/"));
    expect(sessions.sort()).toEqual(
      [mine, trashed, offloaded].map((id) => `sessions/${id}.jsonl`).sort(),
    );
    expect(names.filter((n) => n.startsWith("transcripts/"))).toHaveLength(3);
    expect(names).toEqual(expect.arrayContaining(["README.md", "threads.json"]));
    const all = names.map((n) => strFromU8(files[n] ?? new Uint8Array())).join("\n");
    for (const foreign of [
      carols,
      otherTeam,
      expired,
      "Carol secret",
      "Legal matter",
      "Awaiting purge",
    ]) {
      expect(all).not.toContain(foreign);
    }

    // Pi session format v3: a header line, then the entries in append order.
    const lines = strFromU8(files[`sessions/${mine}.jsonl`] ?? new Uint8Array())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, id: mine });
    expect(lines.slice(1).map((e) => [e.id, e.parentId])).toEqual([
      ["e1", null],
      ["e2", "e1"],
      ["e3", "e2"],
      ["e4", "e3"],
    ]);
    // An offloaded body is read back from object storage.
    const big = strFromU8(files[`sessions/${offloaded}.jsonl`] ?? new Uint8Array())
      .trim()
      .split("\n");
    expect(JSON.parse(big[1] ?? "{}")).toMatchObject({ id: "e1", message: { role: "user" } });
    expect(JSON.parse(big[2] ?? "{}")).toEqual({
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: expect.any(String),
      kaiju_unavailable: true,
    });

    const transcript = names.find((n) => n.startsWith("transcripts/") && n.includes("budget-2027"));
    const md = strFromU8(files[transcript ?? ""] ?? new Uint8Array());
    expect(md).toMatch(/^# Budget 2027/);
    expect(md).toContain("question 1 from Budget 2027");
    expect(md).toContain("answer 4");
    const index = JSON.parse(strFromU8(files["threads.json"] ?? new Uint8Array())) as {
      threads: { id: string; in_trash: boolean }[];
    };
    expect(index.threads.find((t) => t.id === trashed)?.in_trash).toBe(true);
    expect((await audits("thread.exported")).at(-1)).toMatchObject({
      actor_id: ids.bob,
      target: { threads: 3, entries: 8 },
    });

    // Another member's export of the same team holds only their own thread.
    const carolZip = unzipSync((await download(as.carol, "/v1/threads/export")).bytes);
    expect(Object.keys(carolZip).filter((n) => n.startsWith("sessions/"))).toEqual([
      `sessions/${carols}.jsonl`,
    ]);
  });

  it("refuses a stale tab's team", async () => {
    const res = await download(as.bob, `/v1/threads/export?team=${other}`);
    expect(res.status).toBe(409);
  });
});

describe("/export of one conversation (KOBE-450, Pi's /export)", () => {
  const md = (bytes: Uint8Array) => strFromU8(bytes);
  const exportsOf = async (threadId: string) =>
    (await audits("thread.transcript_exported")).filter((a) => a.target.threadId === threadId);

  it("downloads the owner's conversation as Markdown (active branch), audited", async () => {
    const mine = await thread({ owner: ids.bob, title: "Budget 2027", entries: 4 });
    const res = await download(as.bob, `/v1/threads/${mine}/export?team=${team}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      new RegExp(
        `^attachment; filename="\\d{4}-\\d{2}-\\d{2}-budget-2027-${mine.slice(0, 8)}\\.md"$`,
      ),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = md(res.bytes);
    expect(text).toMatch(/^# Budget 2027/);
    expect(text).toContain("question 1 from Budget 2027");
    expect(text).toContain("answer 4");
    expect(await exportsOf(mine)).toEqual([
      expect.objectContaining({ actor_id: ids.bob, target: { threadId: mine, entries: 4 } }),
    ]);
  });

  it("never sniffed; the full export too (review LOW-3)", async () => {
    const mine = await thread({ owner: ids.bob, title: "Sniff" });
    const one = await download(as.bob, `/v1/threads/${mine}/export`);
    expect(one.headers.get("x-content-type-options")).toBe("nosniff");
    const all = await download(as.bob, "/v1/threads/export");
    expect(all.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("one export at a time per user, shared with the full export: 429 (review MEDIUM-1)", async () => {
    const mine = await thread({ owner: ids.bob, title: "Slot", entries: 2 });
    const req = (path: string) =>
      h.app.request(`http://kaiju.test${path}`, {
        headers: {
          origin: "http://kaiju.test",
          "x-forwarded-for": as.bob.ip,
          cookie: [...as.bob.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      });
    // The first download holds the slot until its body is read.
    const first = await req(`/v1/threads/${mine}/export`);
    expect(first.status).toBe(200);
    for (const path of [`/v1/threads/${mine}/export`, "/v1/threads/export"]) {
      const busy = await req(path);
      expect(busy.status).toBe(429);
      expect(((await busy.json()) as { code: string }).code).toBe("export_in_progress");
    }
    // Another member is not held up.
    expect((await download(as.carol, "/v1/threads/export")).status).toBe(200);
    await first.arrayBuffer();
    const again = await req(`/v1/threads/${mine}/export`);
    expect(again.status).toBe(200);
    await again.arrayBuffer(); // releases the slot for the next tests
    // Two audited downloads: the refused ones wrote nothing.
    expect(await exportsOf(mine)).toHaveLength(2);
  });

  it("a thread shared with the member is still not theirs to export (review LOW-7)", async () => {
    const carols = await thread({ owner: ids.carol, title: "Team share" });
    await h.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [carols]);
    expect((await as.bob.get(`/v1/threads/${carols}`)).status).toBe(200);
    expect((await download(as.bob, `/v1/threads/${carols}/export`)).status).toBe(404);
    expect(await exportsOf(carols)).toEqual([]);
  });

  it("Trash is marked; other branches and offloaded bodies are handled (review LOW-7)", async () => {
    const t = await thread({
      owner: ids.bob,
      title: "Branchy",
      entries: 2,
      deletedAt: ago(1),
      blobKeys: [key("branchy-q")],
    });
    // A second answer to e1, off the active branch (leaf e2).
    await h.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'x2', 'e1', 'message', $3)`,
      [
        team,
        t,
        {
          type: "message",
          id: "x2",
          parentId: "e1",
          message: { role: "assistant", content: [{ type: "text", text: "the other version" }] },
        },
      ],
    );
    const res = await download(as.bob, `/v1/threads/${t}/export`);
    expect(res.status).toBe(200);
    const text = md(res.bytes);
    expect(text).toContain("In Trash");
    expect(text).toContain("question 1 from Branchy"); // read back from object storage
    expect(text).toContain("answer 2");
    expect(text).not.toContain("the other version");
  });

  it("only the owner's, in the active team: another member's or team's thread is not found", async () => {
    const carols = await thread({ owner: ids.carol, title: "Carol secret" });
    const elsewhere = await thread({ teamId: other, owner: ids.bob, title: "Legal matter" });
    for (const id of [carols, elsewhere]) {
      const res = await download(as.bob, `/v1/threads/${id}/export`);
      expect(res.status).toBe(404);
      expect(md(res.bytes)).not.toMatch(/Carol secret|Legal matter/);
      expect(await exportsOf(id)).toEqual([]);
    }
  });

  it("refuses a stale tab's team, a bad id and a download another site starts", async () => {
    const mine = await thread({ owner: ids.bob, title: "Plan" });
    expect((await download(as.bob, `/v1/threads/${mine}/export?team=${other}`)).status).toBe(409);
    expect((await download(as.bob, "/v1/threads/not-a-uuid/export")).status).toBe(400);
    const cross = await h.app.request(`http://kaiju.test/v1/threads/${mine}/export`, {
      headers: {
        origin: "http://kaiju.test",
        "sec-fetch-site": "cross-site",
        "x-forwarded-for": as.bob.ip,
        cookie: [...as.bob.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    expect(cross.status).toBe(403);
    expect(await exportsOf(mine)).toEqual([]);
  });
});

describe("offboarding (KOBE-28 entry point)", () => {
  it("refuses while the user is an active member, then purges every thread they own in the team", async () => {
    const dave = await h.createUser(`dave-${randomUUID().slice(0, 6)}@ret.test`);
    await member(team, dave);
    const a = await thread({ owner: dave, blobKeys: [key("dave")] });
    await thread({ owner: dave, deletedAt: new Date() });
    const keep = await thread({ owner: ids.bob });
    const elsewhere = await thread({ teamId: other, owner: dave });
    const db = h.deps.database.db;
    await expect(
      purgeDepartedMember(db, { teamId: team, userId: dave }, blobs),
    ).rejects.toBeInstanceOf(StillAMemberError);
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      dave,
    ]);
    const result = await purgeDepartedMember(db, { teamId: team, userId: dave }, blobs);
    expect(result.threads).toMatchObject({ status: "done", counts: { threads: 2 } });
    expect(result.blobs).toEqual({ blobs: 1, kept: 0 });
    expect(await threadIds()).toEqual([keep]);
    expect(await threadIds(other)).toEqual([elsewhere]);
    expect((await audits("retention.purged")).at(-1)?.target).toMatchObject({
      reason: "offboarding",
      userId: dave,
      threads: 2,
    });
    expect(a).toBeTruthy();
  });

  it("skips a held departed user's threads", async () => {
    const erin = await h.createUser(`erin-${randomUUID().slice(0, 6)}@ret.test`);
    const t = await thread({ owner: erin });
    const hold = await placeHold(team, erin);
    const result = await purgeDepartedMember(
      h.deps.database.db,
      { teamId: team, userId: erin },
      blobs,
    );
    expect(result.threads.counts.threads).toBe(0);
    expect(await threadIds()).toEqual([t]);
    await releaseHold(hold);
  });
});
