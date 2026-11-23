import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { TestBrowser } from "../testing/browser.js";
import { findThread, updateThread } from "./repository.js";
import {
  PUBLIC_URL,
  type Person,
  ids,
  deps,
  app,
  admin,
  as,
  finance,
  marketing,
  signIn,
  activate,
  addMember,
  newThread,
  appendEntries,
  addRun,
  endRun,
  useThreadsApp,
} from "./threads.test-helpers.js";

useThreadsApp();

describe("create (POST /v1/threads)", () => {
  it("creates a thread owned by the caller in the active team", async () => {
    const res = await as.bob.post("/v1/threads", { title: "  Quarterly numbers  " });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      title: "Quarterly numbers",
      status: "idle",
      owner_user_id: ids.bob,
      project_id: null,
      agent_id: null,
      agent_version: null,
      shared_to_project: false,
      leaf_entry_id: null,
      deleted_at: null,
      purge_after: null,
    });
    const { rows } = await admin.query(`SELECT team_id, owner_user_id FROM threads WHERE id = $1`, [
      res.json.thread_id,
    ]);
    expect(rows).toEqual([{ team_id: finance, owner_user_id: ids.bob }]);
  });

  it("takes the team and owner from the session, never from the body", async () => {
    expect((await as.bob.post("/v1/threads", { team_id: marketing })).status).toBe(400);
    expect((await as.bob.post("/v1/threads", { owner_user_id: ids.alice })).status).toBe(400);
  });

  it("refuses agents and projects that don't exist (until KOBE-45/57)", async () => {
    expect(await as.bob.post("/v1/threads", { agent_id: randomUUID() })).toMatchObject({
      status: 404,
      json: { code: "agent_not_found" },
    });
    expect(await as.bob.post("/v1/threads", { project_id: randomUUID() })).toMatchObject({
      status: 404,
      json: { code: "project_not_found" },
    });
    expect((await as.bob.post("/v1/threads", { agent_id: null, project_id: null })).status).toBe(
      201,
    );
  });

  it("validates the body", async () => {
    for (const body of [{ title: "" }, { title: 7 }, { agent_id: "assistant" }, { x: 1 }]) {
      expect((await as.bob.post("/v1/threads", body)).status, JSON.stringify(body)).toBe(400);
    }
    const raw = await as.bob.request("POST", "/v1/threads", undefined, {
      "content-type": "application/json",
    });
    expect(raw.status).toBe(400);
  });

  it("needs X-Kobe-Team on changes and an active team", async () => {
    const tab = await signIn("bob");
    expect((await tab.post("/v1/threads", {})).json.code).toBe("team_header_required");
    tab.team = finance;
    expect(await tab.post("/v1/threads", {})).toMatchObject({
      status: 409,
      json: { code: "no_active_team" },
    });
  });
});

describe("authorization per role (ac-3)", () => {
  it("lets every team role chat: member, builder and team admin", async () => {
    for (const who of ["bob", "carol", "alice"] as const) {
      const id = await newThread(as[who]);
      expect((await as[who].get(`/v1/threads/${id}`)).status, who).toBe(200);
      expect((await as[who].get("/v1/threads")).status, who).toBe(200);
    }
  });

  it("refuses site admins who are not members, and users without a team", async () => {
    for (const who of ["siteAdmin", "owner", "erin"] as const) {
      const res = await as[who].get("/v1/threads");
      expect(res, who).toMatchObject({ status: 409, json: { code: "no_active_team" } });
      const select = await as[who].put("/v1/me/teams/active", { teamId: finance });
      expect(select.status, who).toBe(403);
    }
  });

  it("refuses a member removed from the team at once", async () => {
    await addMember(as.alice, "erin", "member");
    await activate(as.erin, finance);
    const id = await newThread(as.erin);
    const removed = await as.alice.delete(`/v1/team/members/${ids.erin}`);
    expect(removed.status).toBe(204);
    expect((await as.erin.get(`/v1/threads/${id}`)).json.code).toBe("not_a_team_member");
    expect((await as.erin.get("/v1/threads")).status).toBe(403);
  });

  it("requires a session", async () => {
    const anonymous = new TestBrowser(app, PUBLIC_URL);
    expect((await anonymous.get("/v1/threads")).status).toBe(401);
  });
});

describe("visibility: private threads, team admins and other teams", () => {
  let bobs = "";
  const notFound = { status: 404, json: { code: "thread_not_found" } };

  beforeAll(async () => {
    bobs = await newThread(as.bob, { title: "bob's private thread" });
    await appendEntries(finance, bobs, [{ id: "e1", parent: null }]);
  });

  it("hides another member's thread from team admins and builders, like an unknown id", async () => {
    const unknown = await as.alice.get(`/v1/threads/${randomUUID()}`);
    expect(unknown).toMatchObject(notFound);
    for (const who of ["alice", "carol"] as const) {
      const paths = [`/v1/threads/${bobs}`, `/v1/threads/${bobs}/entries`];
      for (const path of paths) expect(await as[who].get(path), `${who} ${path}`).toEqual(unknown);
      expect(await as[who].patch(`/v1/threads/${bobs}`, { title: "mine" })).toEqual(unknown);
      expect(await as[who].post(`/v1/threads/${bobs}/leaf`, { entry_id: "e1" })).toEqual(unknown);
      expect(await as[who].delete(`/v1/threads/${bobs}`)).toEqual(unknown);
      expect(await as[who].post(`/v1/threads/${bobs}/restore`)).toEqual(unknown);
      const list = await as[who].get("/v1/threads?limit=100");
      expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(bobs);
    }
  });

  it("never reaches another team's thread, even for its own owner", async () => {
    const bobInMarketing = await signIn("bob");
    await activate(bobInMarketing, marketing);
    const unknown = await bobInMarketing.get(`/v1/threads/${randomUUID()}`);
    expect(unknown).toMatchObject(notFound);
    expect(await bobInMarketing.get(`/v1/threads/${bobs}`)).toEqual(unknown);
    expect(await bobInMarketing.patch(`/v1/threads/${bobs}`, { title: "x" })).toEqual(unknown);
    expect(await bobInMarketing.delete(`/v1/threads/${bobs}`)).toEqual(unknown);
    expect(await bobInMarketing.post(`/v1/threads/${bobs}/leaf`, { entry_id: "e1" })).toEqual(
      unknown,
    );
    const list = await bobInMarketing.get("/v1/threads?limit=100");
    expect(list.json.threads).toEqual([]);
    // The marketing team admin sees nothing of finance either.
    expect(await as.dave.get(`/v1/threads/${bobs}`)).toEqual(unknown);
    // Threads made in marketing stay there.
    const there = await newThread(bobInMarketing);
    expect((await as.bob.get(`/v1/threads/${there}`)).status).toBe(404);
    const { rows } = await admin.query(`SELECT team_id FROM threads WHERE id = $1`, [there]);
    expect(rows).toEqual([{ team_id: marketing }]);
  });

  it("rejects a stale tab whose X-Kobe-Team names another team", async () => {
    const res = await as.bob.request(
      "PATCH",
      `/v1/threads/${bobs}`,
      { title: "t" },
      {
        "x-kobe-team": marketing,
      },
    );
    expect(res).toMatchObject({ status: 409, json: { code: "team_mismatch" } });
  });

  it("validates ids in the path", async () => {
    expect((await as.bob.get("/v1/threads/not-a-uuid")).status).toBe(400);
    const upper = await as.bob.get(`/v1/threads/${bobs.toUpperCase()}`);
    expect(upper).toMatchObject({ status: 200, json: { thread_id: bobs } });
  });
});

describe("shared project threads (D23, data layer)", () => {
  const project = randomUUID();
  let shared = "";

  beforeAll(async () => {
    // threads.project_id references projects (KOBE-160): the project row comes first.
    await admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by)
       VALUES ($1, $2, 'plan', 'Plan', $3)`,
      [finance, project, ids.alice],
    );
    // bob is in the team without a row: an implicit reader (KOBE-587, RV1).
    await admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
       VALUES ($1, $2, $3, 'owner', $3)`,
      [finance, project, ids.alice],
    );
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, project_id, title) VALUES ($1, $2, $3, 'plan')
       RETURNING id`,
      [finance, ids.alice, project],
    );
    shared = rows[0]?.id ?? "";
    expect(shared).not.toBe("");
  });

  const viewer = (who: Person, projectIds: string[]) => ({
    teamId: finance,
    userId: ids[who],
    projectIds,
  });

  it("lets the owner share a project thread; members of the project read it, read-only", async () => {
    expect(
      (await as.alice.patch(`/v1/threads/${shared}`, { shared_to_project: true })).status,
    ).toBe(200);
    const db = deps.database.db;
    const asBob = await withTeam(db, finance, (tx) =>
      findThread(tx, viewer("bob", [project]), shared),
    );
    expect(asBob?.access).toBe("reader");
    const notMember = await withTeam(db, finance, (tx) =>
      findThread(tx, viewer("bob", [randomUUID()]), shared),
    );
    expect(notMember).toBeNull();
    const change = await withTeam(db, finance, (tx) =>
      updateThread(tx, viewer("bob", [project]), shared, { title: "hijack" }),
    );
    expect(change).toEqual({ ok: false, error: "read_only" });
    // Another team never sees it, whatever project ids are claimed.
    const otherTeam = await withTeam(db, marketing, (tx) =>
      findThread(tx, { teamId: marketing, userId: ids.bob, projectIds: [project] }, shared),
    );
    expect(otherTeam).toBeNull();
  });

  it("hides an unshared or trashed project thread from project members", async () => {
    const db = deps.database.db;
    await as.alice.patch(`/v1/threads/${shared}`, { shared_to_project: false });
    expect(
      await withTeam(db, finance, (tx) => findThread(tx, viewer("bob", [project]), shared)),
    ).toBeNull();
    await as.alice.patch(`/v1/threads/${shared}`, { shared_to_project: true });
    await as.alice.delete(`/v1/threads/${shared}`);
    expect(
      await withTeam(db, finance, (tx) => findThread(tx, viewer("bob", [project]), shared)),
    ).toBeNull();
    await as.alice.post(`/v1/threads/${shared}/restore`);
  });

  it("only shares threads that belong to a project", async () => {
    const plain = await newThread(as.alice);
    expect(await as.alice.patch(`/v1/threads/${plain}`, { shared_to_project: true })).toMatchObject(
      { status: 409, json: { code: "not_in_project" } },
    );
  });

  it("lists a project's threads the viewer may read (every workspace member reads, RV1)", async () => {
    const ids = (r: { json: { threads: { thread_id: string }[] } }) =>
      r.json.threads.map((t) => t.thread_id);
    expect(ids(await as.alice.get(`/v1/threads?project_id=${project}`))).toEqual([shared]);
    expect(ids(await as.bob.get(`/v1/threads?project_id=${project}`))).toEqual([shared]);
  });
});

describe("read with entries (GET /v1/threads/{id})", () => {
  let id = "";

  beforeAll(async () => {
    id = await newThread(as.carol, { title: "branches" });
    // e1 → e2 → e3, and an edit of e2 (e2b) branching from e1, plus an offloaded body.
    await appendEntries(finance, id, [
      { id: "e1", parent: null },
      { id: "e2", parent: "e1" },
      { id: "e3", parent: "e2" },
      { id: "e2b", parent: "e1" },
      { id: "big", parent: "e2b", blob: true },
    ]);
    await admin.query(`UPDATE threads SET leaf_entry_id = 'e3' WHERE id = $1`, [id]);
  });

  it("returns the thread, the whole entry tree in append order and the leaf", async () => {
    const res = await as.carol.get(`/v1/threads/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      thread_id: id,
      leaf_entry_id: "e3",
      agent_version: null,
      status: "idle",
      next_entries_after: null,
    });
    expect(
      res.json.entries.map((e: { entry_id: string; parent_id: string | null; seq: number }) => [
        e.entry_id,
        e.parent_id,
        e.seq,
      ]),
    ).toEqual([
      ["e1", null, 1],
      ["e2", "e1", 2],
      ["e3", "e2", 3],
      ["e2b", "e1", 4],
      ["big", "e2b", 5],
    ]);
    expect(res.json.entries[0]).toMatchObject({
      type: "message",
      payload: { message: { role: "user", content: "text e1" } },
      payload_offloaded: false,
    });
    expect(res.json.entries[4]).toMatchObject({ payload: {}, payload_offloaded: true });
    expect(JSON.stringify(res.json)).not.toContain("blobs/");
  });

  it("pages entries by seq", async () => {
    const first = await as.carol.get(`/v1/threads/${id}?limit=2`);
    expect(first.json.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    expect(first.json.next_entries_after).toBe(2);
    const second = await as.carol.get(`/v1/threads/${id}/entries?after=2&limit=2`);
    expect(second.json.entries.map((e: { seq: number }) => e.seq)).toEqual([3, 4]);
    const last = await as.carol.get(`/v1/threads/${id}/entries?after=4&limit=2`);
    expect(last.json).toMatchObject({ next_entries_after: null });
    expect(last.json.entries.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect((await as.carol.get(`/v1/threads/${id}/entries?limit=501`)).status).toBe(400);
  });

  it("returns an empty thread with no entries", async () => {
    const empty = await newThread(as.carol);
    expect((await as.carol.get(`/v1/threads/${empty}`)).json).toMatchObject({
      entries: [],
      next_entries_after: null,
      leaf_entry_id: null,
    });
  });

  it("switches the active branch to an entry of the thread", async () => {
    const res = await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "big" });
    expect(res).toMatchObject({ status: 200, json: { leaf_entry_id: "big" } });
    expect((await as.carol.get(`/v1/threads/${id}`)).json.leaf_entry_id).toBe("big");
  });

  it("refuses a leaf that is not an entry of this thread", async () => {
    const other = await newThread(as.carol);
    await appendEntries(finance, other, [{ id: "elsewhere", parent: null }]);
    for (const entry_id of ["nope", "elsewhere"]) {
      expect(await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id })).toMatchObject({
        status: 404,
        json: { code: "entry_not_found" },
      });
    }
    expect((await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "" })).status).toBe(400);
  });

  it("refuses to switch the leaf while a run holds the thread", async () => {
    const run = await addRun(finance, id, "running");
    expect(await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "e3" })).toMatchObject({
      status: 409,
      json: { code: "thread_busy" },
    });
    await endRun(finance, run);
    expect((await as.carol.post(`/v1/threads/${id}/leaf`, { entry_id: "e3" })).status).toBe(200);
  });
});
