import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { TestBrowser } from "../testing/browser.js";
import {
  entryPageSchema,
  threadDetailSchema,
  threadEntrySchema,
  threadPageSchema,
  threadSearchPageSchema,
  threadSummarySchema,
} from "./schemas.js";
import {
  PUBLIC_URL,
  ids,
  database,
  deps,
  admin,
  as,
  finance,
  marketing,
  activate,
  newThread,
  appendEntries,
  addRun,
  endRun,
  useThreadsApp,
} from "./threads.test-helpers.js";

useThreadsApp();

describe("rename", () => {
  it("renames and clears the title", async () => {
    const id = await newThread(as.bob, { title: "old" });
    expect(await as.bob.patch(`/v1/threads/${id}`, { title: " new " })).toMatchObject({
      status: 200,
      json: { title: "new" },
    });
    expect((await as.bob.patch(`/v1/threads/${id}`, { title: null })).json.title).toBeNull();
    expect((await as.bob.patch(`/v1/threads/${id}`, {})).status).toBe(400);
    expect((await as.bob.patch(`/v1/threads/${id}`, { status: "idle" })).status).toBe(400);
  });

  it("a rename locks the title against auto-titling; clearing it unlocks (KOBE-292)", async () => {
    const id = await newThread(as.bob, { title: "first line" });
    const locked = async () =>
      (await admin.query("SELECT title_locked FROM threads WHERE id = $1", [id])).rows[0]
        ?.title_locked;
    expect(await locked()).toBe(false);
    expect((await as.bob.patch(`/v1/threads/${id}`, { title: "Budget" })).status).toBe(200);
    expect(await locked()).toBe(true);
    expect((await as.bob.patch(`/v1/threads/${id}`, { title: null })).status).toBe(200);
    expect(await locked()).toBe(false);
  });
});

describe("Trash and restore (D18 soft delete)", () => {
  it("moves a thread to Trash, out of the list, and back", async () => {
    const id = await newThread(as.bob, { title: "to trash" });
    const del = await as.bob.delete(`/v1/threads/${id}`);
    expect(del.status).toBe(200);
    const deletedAt = Date.parse(del.json.deleted_at);
    expect(Date.parse(del.json.purge_after) - deletedAt).toBe(30 * 86_400_000);
    expect((await as.bob.delete(`/v1/threads/${id}`)).json.deleted_at).toBe(del.json.deleted_at);

    const list = await as.bob.get("/v1/threads?limit=100");
    expect(list.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(id);
    const trash = await as.bob.get("/v1/threads/trash");
    expect(trash.json.threads.map((t: { thread_id: string }) => t.thread_id)).toContain(id);
    // The owner can still open it; changes wait for restore.
    expect((await as.bob.get(`/v1/threads/${id}`)).json.deleted_at).toBe(del.json.deleted_at);
    expect(await as.bob.patch(`/v1/threads/${id}`, { title: "x" })).toMatchObject({
      status: 409,
      json: { code: "thread_in_trash" },
    });
    expect((await as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "e" })).status).toBe(409);
    // Another member's Trash is theirs alone.
    const alicesTrash = await as.alice.get("/v1/threads/trash");
    expect(alicesTrash.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(
      id,
    );

    const restored = await as.bob.post(`/v1/threads/${id}/restore`);
    expect(restored).toMatchObject({ status: 200, json: { deleted_at: null, purge_after: null } });
    expect(await as.bob.post(`/v1/threads/${id}/restore`)).toMatchObject({
      status: 409,
      json: { code: "not_in_trash" },
    });
  });

  it("restores only within 30 days", async () => {
    const id = await newThread(as.bob);
    await as.bob.delete(`/v1/threads/${id}`);
    await admin.query(`UPDATE threads SET deleted_at = now() - interval '31 days' WHERE id = $1`, [
      id,
    ]);
    const trash = await as.bob.get("/v1/threads/trash?limit=100");
    expect(trash.json.threads.map((t: { thread_id: string }) => t.thread_id)).not.toContain(id);
    expect(await as.bob.post(`/v1/threads/${id}/restore`)).toMatchObject({
      status: 404,
      json: { code: "thread_not_found" },
    });
  });

  it("refuses to trash a thread with an active or queued run", async () => {
    const id = await newThread(as.bob);
    for (const status of ["running", "waiting_approval", "queued"]) {
      const run = await addRun(finance, id, status);
      expect(await as.bob.delete(`/v1/threads/${id}`), status).toMatchObject({
        status: 409,
        json: { code: "thread_busy" },
      });
      await endRun(finance, run);
    }
    expect((await as.bob.delete(`/v1/threads/${id}`)).status).toBe(200);
  });
});

describe("list pagination (GET /v1/threads)", () => {
  let dave: TestBrowser;
  let made: string[] = [];

  beforeAll(async () => {
    // A fresh member with only these threads: some share a timestamp to the microsecond, some
    // differ by a microsecond, so ordering relies on the id tiebreak and µs-precise cursors.
    dave = as.dave;
    made = [];
    for (let i = 0; i < 9; i++) made.push(await newThread(dave, { title: `t${i}` }));
    const stamps = [
      "2026-10-01 12:00:00.000001+00",
      "2026-10-01 12:00:00.000001+00",
      "2026-10-01 12:00:00.000001+00",
      "2026-10-01 12:00:00.000002+00",
      "2026-10-01 12:00:00.000002+00",
      "2026-10-01 12:00:00.0000025+00",
      "2026-10-01 12:00:00.000003+00",
      "2026-09-30 00:00:00+00",
      "2026-10-01 12:00:00.000999+00",
    ];
    for (const [i, id] of made.entries()) {
      await admin.query(`UPDATE threads SET last_activity_at = $2 WHERE id = $1`, [id, stamps[i]]);
    }
  });

  async function walk(b: TestBrowser, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 50; pages++) {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const res = await b.get(`/v1/threads?limit=${limit}${qs}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      seen.push(...res.json.threads.map((t: { thread_id: string }) => t.thread_id));
      cursor = res.json.next_cursor;
      if (!cursor) return seen;
    }
    throw new Error("pagination did not end");
  }

  it("returns every thread exactly once, newest activity first, id breaking ties", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM threads WHERE team_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
       ORDER BY last_activity_at DESC, id DESC`,
      [marketing, ids.dave],
    );
    const expected = rows.map((r) => r.id);
    expect(expected).toHaveLength(9);
    for (const limit of [1, 2, 3, 4, 100])
      expect(await walk(dave, limit), `${limit}`).toEqual(expected);
  });

  it("stays stable while threads gain activity or are created between pages", async () => {
    const first = await dave.get("/v1/threads?limit=4");
    const firstIds = first.json.threads.map((t: { thread_id: string }) => t.thread_id);
    // A new thread and a bumped thread from page 1 move to the top: neither appears on later
    // pages, and nothing after the cursor is skipped or repeated.
    await newThread(dave, { title: "new between pages" });
    await admin.query(`UPDATE threads SET last_activity_at = now() WHERE id = $1`, [firstIds[3]]);
    const rest: string[] = [];
    let cursor: string | null = first.json.next_cursor;
    while (cursor) {
      const res = await dave.get(`/v1/threads?limit=4&cursor=${cursor}`);
      rest.push(...res.json.threads.map((t: { thread_id: string }) => t.thread_id));
      cursor = res.json.next_cursor;
    }
    expect([...firstIds, ...rest].sort()).toEqual([...made].sort());
  });

  it("rejects malformed cursors and limits", async () => {
    expect(await dave.get("/v1/threads?cursor=garbage")).toMatchObject({
      status: 400,
      json: { code: "invalid_cursor" },
    });
    const extreme = Buffer.from(
      JSON.stringify({ a: "99999999999999999", i: "ffffffff-ffff-4fff-bfff-ffffffffffff" }),
    ).toString("base64url");
    expect((await dave.get(`/v1/threads?cursor=${extreme}`)).status).toBe(200);
    expect((await dave.get("/v1/threads?limit=0")).status).toBe(400);
    expect((await dave.get("/v1/threads?limit=101")).status).toBe(400);
    expect((await dave.get("/v1/threads?team_id=x")).status).toBe(400);
    expect((await dave.get("/v1/threads/trash?cursor=garbage")).status).toBe(400);
  });

  it("pages the Trash by deletion time", async () => {
    const trashed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await newThread(dave);
      expect((await dave.delete(`/v1/threads/${id}`)).status).toBe(200);
      trashed.unshift(id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : "";
      const res = await dave.get(`/v1/threads/trash?limit=1${qs}`);
      seen.push(...res.json.threads.map((t: { thread_id: string }) => t.thread_id));
      cursor = res.json.next_cursor;
    } while (cursor);
    expect(seen).toEqual(trashed);
  });
});

describe("security review fixes", () => {
  it("never returns a stored payload for an offloaded entry", async () => {
    const id = await newThread(as.bob);
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, type, payload, blob_ref)
       VALUES ($1, $2, 'off', 'message', '{"message":{"content":"inline copy"}}', 'blobs/off')`,
      [finance, id],
    );
    for (const path of [`/v1/threads/${id}`, `/v1/threads/${id}/entries`]) {
      const res = await as.bob.get(path);
      expect(res.json.entries, path).toEqual([
        expect.objectContaining({ entry_id: "off", payload: {}, payload_offloaded: true }),
      ]);
      expect(JSON.stringify(res.json)).not.toContain("inline copy");
    }
  });

  it("answers thread_busy instead of waiting when the thread row stays locked", async () => {
    const id = await newThread(as.bob);
    await appendEntries(finance, id, [{ id: "l1", parent: null }]);
    await as.bob.delete(`/v1/threads/${id}`);
    await as.bob.post(`/v1/threads/${id}/restore`);
    // An appender (seq trigger) or another writer holding the row past the lock timeout.
    const holder = new pg.Client({ connectionString: database.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM threads WHERE id = $1 FOR UPDATE", [id]);
      const calls = [
        () => as.bob.patch(`/v1/threads/${id}`, { title: "x" }),
        () => as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "l1" }),
        () => as.bob.delete(`/v1/threads/${id}`),
        () => as.bob.post(`/v1/threads/${id}/restore`),
      ];
      for (const call of calls) {
        const started = Date.now();
        expect(await call()).toMatchObject({ status: 409, json: { code: "thread_busy" } });
        expect(Date.now() - started).toBeLessThan(5_000);
      }
      // Reads don't lock and are not blocked.
      expect((await as.bob.get(`/v1/threads/${id}`)).status).toBe(200);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect((await as.bob.patch(`/v1/threads/${id}`, { title: "x" })).status).toBe(200);
  });

  it("treats Trash older than 30 days as gone everywhere", async () => {
    const id = await newThread(as.bob);
    await appendEntries(finance, id, [{ id: "x1", parent: null }]);
    await as.bob.delete(`/v1/threads/${id}`);
    await admin.query(`UPDATE threads SET deleted_at = now() - interval '31 days' WHERE id = $1`, [
      id,
    ]);
    const gone = { status: 404, json: { code: "thread_not_found" } };
    expect(await as.bob.get(`/v1/threads/${id}`)).toMatchObject(gone);
    expect(await as.bob.get(`/v1/threads/${id}/entries`)).toMatchObject(gone);
    expect(await as.bob.delete(`/v1/threads/${id}`)).toMatchObject(gone);
    expect(await as.bob.patch(`/v1/threads/${id}`, { title: "t" })).toMatchObject(gone);
    expect(await as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "x1" })).toMatchObject(gone);
    expect(await as.bob.post(`/v1/threads/${id}/restore`)).toMatchObject(gone);
  });
});

describe("responses match the OpenAPI schemas (ac-1)", () => {
  it("returns exactly the documented fields", async () => {
    const summary = threadSummarySchema.strict();
    const entry = threadEntrySchema.strict();
    const created = await as.bob.post("/v1/threads", { title: "schema" });
    summary.parse(created.json);
    const id = created.json.thread_id as string;
    await appendEntries(finance, id, [
      { id: "s1", parent: null },
      { id: "s2", parent: "s1" },
    ]);
    threadDetailSchema
      .extend({ entries: entry.array() })
      .strict()
      .parse((await as.bob.get(`/v1/threads/${id}`)).json);
    entryPageSchema
      .extend({ entries: entry.array() })
      .strict()
      .parse((await as.bob.get(`/v1/threads/${id}/entries?after=1`)).json);
    threadPageSchema
      .extend({ threads: summary.array() })
      .strict()
      .parse((await as.bob.get("/v1/threads")).json);
    summary.parse((await as.bob.patch(`/v1/threads/${id}`, { title: "s" })).json);
    summary.parse((await as.bob.post(`/v1/threads/${id}/leaf`, { entry_id: "s2" })).json);
    summary.parse((await as.bob.delete(`/v1/threads/${id}`)).json);
    threadPageSchema
      .extend({ threads: summary.array() })
      .strict()
      .parse((await as.bob.get("/v1/threads/trash")).json);
    summary.parse((await as.bob.post(`/v1/threads/${id}/restore`)).json);
  });
});

describe("search (GET /v1/threads?q=, KOBE-33)", () => {
  /** Appends a Pi user message with `text` as the database owner would (writers: KOBE-30/23). */
  async function say(teamId: string, threadId: string, entryId: string, text: string) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, type, payload)
       VALUES ($1, $2, $3, 'message', $4)`,
      [teamId, threadId, entryId, JSON.stringify({ message: { role: "user", content: text } })],
    );
  }
  const searchIds = async (b: TestBrowser, q: string): Promise<string[]> => {
    const res = await b.get(`/v1/threads?q=${encodeURIComponent(q)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return threadSearchPageSchema.parse(res.json).threads.map((t) => t.thread_id);
  };

  it("finds the viewer's thread by message text, with summary, matched entry and snippet", async () => {
    const id = await newThread(as.bob, { title: "Budget review" });
    await say(finance, id, "s1", "the narwhal forecast for Q4");
    const res = await as.bob.get("/v1/threads?q=narwhal");
    expect(res.status).toBe(200);
    const page = threadSearchPageSchema.parse(res.json);
    expect(page.next_cursor).toBeNull();
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      thread_id: id,
      title: "Budget review",
      owner_user_id: ids.bob,
      deleted_at: null,
      matched_entry_id: "s1",
    });
    expect(page.threads[0]?.snippet?.filter((s) => s.highlight).map((s) => s.text)).toEqual([
      "narwhal",
    ]);
    // Title search, and the summary equals what the thread read returns.
    const [hit] = threadSearchPageSchema.parse(
      (await as.bob.get("/v1/threads?q=budget")).json,
    ).threads;
    const detail = threadDetailSchema.parse((await as.bob.get(`/v1/threads/${id}`)).json);
    const {
      entries: _e,
      next_entries_after: _n,
      agent_current_version: _v,
      agent_model: _am,
      agent_name: _an,
      agent_status: _as,
      agent_dangerous: _ad,
      ...summary
    } = detail;
    const { matched_entry_id: _m, snippet: _s, score: _sc, ...hitSummary } = hit ?? {};
    expect(hitSummary).toEqual(summary);
  });

  it("never returns another user's private thread, not even to the team admin", async () => {
    const id = await newThread(as.carol);
    await say(finance, id, "p1", "carol's pangolin plan");
    expect(await searchIds(as.carol, "pangolin")).toEqual([id]);
    expect(await searchIds(as.bob, "pangolin")).toEqual([]);
    expect(await searchIds(as.alice, "pangolin")).toEqual([]);
  });

  it("is scoped to the active team, even for the same user's own threads", async () => {
    const inFinance = await newThread(as.bob);
    await say(finance, inFinance, "q1", "quasar in finance");
    await activate(as.bob, marketing);
    try {
      const inMarketing = await newThread(as.bob);
      await say(marketing, inMarketing, "q1", "quasar in marketing");
      expect(await searchIds(as.bob, "quasar")).toEqual([inMarketing]);
      expect(await searchIds(as.dave, "quasar")).toEqual([]);
    } finally {
      await activate(as.bob, finance);
    }
    expect(await searchIds(as.bob, "quasar")).toEqual([inFinance]);
  });

  it("leaves out Trash", async () => {
    const id = await newThread(as.bob);
    await say(finance, id, "t1", "binned wombat");
    expect(await searchIds(as.bob, "wombat")).toEqual([id]);
    expect((await as.bob.delete(`/v1/threads/${id}`)).status).toBe(200);
    expect(await searchIds(as.bob, "wombat")).toEqual([]);
  });

  it("pages with a search cursor and caps limit at 50", async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await newThread(as.bob);
      await say(finance, id, "c1", `capybara note ${i}`);
      created.push(id);
    }
    const first = await as.bob.get("/v1/threads?q=capybara&limit=2");
    const page1 = threadSearchPageSchema.parse(first.json);
    expect(page1.threads).toHaveLength(2);
    const second = await as.bob.get(
      `/v1/threads?q=capybara&limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? "")}`,
    );
    const page2 = threadSearchPageSchema.parse(second.json);
    expect(page2.next_cursor).toBeNull();
    expect([...page1.threads, ...page2.threads].map((t) => t.thread_id).sort()).toEqual(
      created.sort(),
    );
    expect((await as.bob.get("/v1/threads?q=capybara&limit=100")).status).toBe(200);
  });

  it("answers 400 for an empty or negation-only query and for a bad cursor", async () => {
    expect((await as.bob.get("/v1/threads?q=%20%20")).json).toMatchObject({
      code: "invalid_request",
    });
    expect(await as.bob.get(`/v1/threads?q=${encodeURIComponent('-alpha -"b c"')}`)).toMatchObject({
      status: 400,
      json: { code: "invalid_query" },
    });
    expect(await as.bob.get("/v1/threads?q=alpha&cursor=bogus")).toMatchObject({
      status: 400,
      json: { code: "invalid_cursor" },
    });
  });

  it("answers 503 search_timeout when the search exceeds its time limit, and stays usable", async () => {
    const id = await newThread(as.bob);
    await say(finance, id, "l1", "locked ocelot");
    const locker = new pg.Client({ connectionString: database.adminUrl });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE thread_entries IN ACCESS EXCLUSIVE MODE");
      const res = await as.bob.get("/v1/threads?q=ocelot");
      expect(res.status).toBe(503);
      expect(res.json).toMatchObject({ code: "search_timeout" });
      expect(JSON.stringify(res.json)).not.toMatch(/select|ocelot/i);
    } finally {
      await locker.query("ROLLBACK");
      await locker.end();
    }
    expect(await searchIds(as.bob, "ocelot")).toEqual([id]);
  }, 20_000);
});

describe("history reads never wake sandboxes (ac-2)", () => {
  it("serves thread reads from Postgres alone", async () => {
    // Deps that expose only the database and the session check: any other dependency (sandbox
    // orchestration, isolation, user management) throws if a read path touches it.
    // `agentLimits` is static configuration the agent routes read when mounted (KOBE-46);
    // `runAgents.pinnedModel` (KOBE-44) reads the agent's model pin in the read's transaction.
    // `kobeMcp` (KOBE-619): `createApp` binds its router to it once, at construction.
    // `sso.settings` (KOBE-774): the session check reads the static settings (the kill switch,
    // Helm secrets) to see whether "Require single sign-on" is in force.
    const allowed = new Set<PropertyKey>([
      "database",
      "auth",
      "publicUrl",
      "agentLimits",
      "runAgents",
      "kobeMcp",
      "sso",
    ]);
    // Of `sso`, only its static settings (not `net`, outbound IdP calls, or the provider store).
    const ssoSettingsOnly = new Proxy(deps.sso, {
      get(target, prop, receiver) {
        if (prop !== "settings") throw new Error(`thread read touched deps.sso.${String(prop)}`);
        return Reflect.get(target, prop, receiver);
      },
    });
    const readOnlyDeps = new Proxy(deps, {
      get(target, prop, receiver) {
        if (!allowed.has(prop)) throw new Error(`thread read touched deps.${String(prop)}`);
        if (prop === "sso") return ssoSettingsOnly;
        return Reflect.get(target, prop, receiver);
      },
    });
    const isolatedApp = createApp(readOnlyDeps);
    const b = new TestBrowser(isolatedApp, PUBLIC_URL);
    for (const [k, v] of as.bob.cookies) b.cookies.set(k, v);
    const id = await newThread(as.bob);
    for (const path of [
      "/v1/threads",
      `/v1/threads/${id}`,
      `/v1/threads/${id}/entries`,
      "/v1/threads/trash",
    ]) {
      expect((await b.get(path)).status, path).toBe(200);
    }
  });
});
