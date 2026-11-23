import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  workspaceFileErrorSchema,
  workspaceListResponseSchema,
  workspaceSearchResponseSchema,
} from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { SEARCH_RATE_LIMIT } from "../routes/workspace-files.js";
import { searchFiles } from "./search.js";
import { PUBLIC_URL, must } from "../testing/event-stream-fixture.js";
import { TestBrowser } from "../testing/browser.js";
import { workspaceBlobKey } from "../workspace-sync/index.js";
import {
  fx,
  objects,
  woken,
  sync,
  app,
  world,
  sha,
  seed,
  auditRows,
  pagedBrowser,
  useWorkspaceFilesWorld,
} from "./workspace-files.test-helpers.js";

useWorkspaceFilesWorld();

describe("GET /v1/workspace/files paging (KOBE-184)", () => {
  const page = (b: TestBrowser, cursor?: string, path = "") =>
    b.get(
      `/v1/workspace/files?path=${path}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );

  it("pages in a stable order (folders first, then name) with an opaque cursor", async () => {
    const w = await world();
    for (const f of ["d1/x", "d2/x", "a.txt", "b.txt", "c.txt"]) await seed(w, w.alice, f, "x");
    const b = pagedBrowser(w);
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await page(b, cursor);
      expect(res.status, res.text).toBe(200);
      const body = workspaceListResponseSchema.parse(res.json);
      expect(body.entries.length).toBeLessThanOrEqual(2);
      names.push(...body.entries.map((e) => e.name));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(names).toEqual(["d1", "d2", "a.txt", "b.txt", "c.txt"]);
    expect(pages).toBe(3);
  });

  it("the last full page has no cursor, and a default-size listing never has one", async () => {
    const w = await world();
    await seed(w, w.alice, "a", "x");
    await seed(w, w.alice, "b", "x");
    expect(workspaceListResponseSchema.parse((await page(pagedBrowser(w))).json).next_cursor).toBe(
      undefined,
    );
    for (const f of ["c", "d"]) await seed(w, w.alice, f, "x");
    expect((await w.a.get("/v1/workspace/files")).json).not.toHaveProperty("next_cursor");
  });

  it("is a position: files added or removed between pages never repeat or skip the rest", async () => {
    const w = await world();
    for (const f of ["a", "b", "c", "d"]) await seed(w, w.alice, f, "x");
    const b = pagedBrowser(w);
    const first = workspaceListResponseSchema.parse((await page(b)).json);
    expect(first.entries.map((e) => e.name)).toEqual(["a", "b"]);
    await seed(w, w.alice, "0-before", "x"); // sorts before the cursor
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=a")).status).toBe(204);
    await seed(w, w.alice, "bb", "x"); // sorts after the cursor
    const second = workspaceListResponseSchema.parse((await page(b, first.next_cursor)).json);
    expect(second.entries.map((e) => e.name)).toEqual(["bb", "c"]);
    expect(
      workspaceListResponseSchema
        .parse((await page(b, second.next_cursor)).json)
        .entries.map((e) => e.name),
    ).toEqual(["d"]);
  });

  it("pages inside a folder; a cursor past the end is an empty page, not a 404", async () => {
    const w = await world();
    for (const f of ["f/1", "f/2", "f/3"]) await seed(w, w.alice, f, "x");
    const b = pagedBrowser(w);
    const first = workspaceListResponseSchema.parse((await page(b, undefined, "f")).json);
    expect(first.entries.map((e) => e.name)).toEqual(["1", "2"]);
    const last = workspaceListResponseSchema.parse((await page(b, first.next_cursor, "f")).json);
    expect(last.entries.map((e) => e.name)).toEqual(["3"]);
    await w.a.request("DELETE", "/v1/workspace/files?path=f/3");
    const empty = await page(b, first.next_cursor, "f");
    expect(empty.status).toBe(200);
    expect(workspaceListResponseSchema.parse(empty.json).entries).toEqual([]);
  });

  it("refuses a cursor it did not issue", async () => {
    const w = await world();
    await seed(w, w.alice, "a", "x");
    for (const bad of ["!!!", "bm90LWpzb24", Buffer.from('{"d":2,"n":1}').toString("base64url")]) {
      const res = await page(pagedBrowser(w), bad);
      expect(res.status, bad).toBe(400);
    }
  });
});

describe("GET /v1/workspace/files", () => {
  it("lists a folder from the synced manifest: dirs first, areas and owners", async () => {
    const w = await world();
    await seed(w, w.alice, "notes.md", "# hi");
    await seed(w, w.alice, "src/a.ts", "a");
    await seed(w, w.alice, "src/deep/b.ts", "bb");
    await seed(w, w.alice, "uploads/t1/report.pdf", "pdf", "uploads");
    const root = await w.a.get("/v1/workspace/files");
    expect(root.status).toBe(200);
    const body = workspaceListResponseSchema.parse(root.json);
    expect(body.path).toBe("");
    expect(body.entries.map((e) => [e.name, e.type, e.area, e.owner, e.source])).toEqual([
      ["src", "dir", "workspace", "sandbox", "synced"],
      ["uploads", "dir", "uploads", "server", "synced"],
      ["notes.md", "file", "workspace", "sandbox", "synced"],
    ]);
    const notes = must(
      body.entries.find((e) => e.name === "notes.md"),
      "notes",
    );
    expect(notes).toMatchObject({
      path: "notes.md",
      size_bytes: 4,
      sha256: sha(Buffer.from("# hi")),
    });
    const src = workspaceListResponseSchema.parse(
      (await w.a.get("/v1/workspace/files?path=src")).json,
    );
    expect(src.entries.map((e) => [e.path, e.type, e.size_bytes])).toEqual([
      ["src/deep", "dir", null],
      ["src/a.ts", "file", 1],
    ]);
    const up = workspaceListResponseSchema.parse(
      (await w.a.get("/v1/workspace/files?path=uploads/t1")).json,
    );
    expect(up.entries).toMatchObject([
      { path: "uploads/t1/report.pdf", owner: "server", area: "uploads" },
    ]);
  });

  it("an empty root is an empty list; an unknown folder is not_found; bad paths are refused", async () => {
    const w = await world();
    expect((await w.a.get("/v1/workspace/files")).json).toEqual({ path: "", entries: [] });
    const missing = await w.a.get("/v1/workspace/files?path=nope");
    expect(missing.status).toBe(404);
    expect(workspaceFileErrorSchema.parse(missing.json).code).toBe("not_found");
    for (const bad of ["../x", "a/../b", "/abs", "a//b"]) {
      const res = await w.a.get(`/v1/workspace/files?path=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("invalid_path");
    }
    expect((await w.a.get("/v1/workspace/files?path=a&x=1")).status).toBe(400);
  });

  it("never lists deleted files, and works with no sandbox at all (no wake)", async () => {
    const w = await world();
    const before = woken.length;
    await seed(w, w.alice, "gone.txt", "x");
    await seed(w, w.alice, "kept.txt", "y");
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=gone.txt")).status).toBe(204);
    const list = workspaceListResponseSchema.parse((await w.a.get("/v1/workspace/files")).json);
    expect(list.entries.map((e) => e.name)).toEqual(["kept.txt"]);
    expect(woken.length).toBe(before);
  });

  it("shows only the caller's own workspace, never a teammate's", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    await seed(w, w.bob, "bobs.txt", "bob only");
    expect(
      workspaceListResponseSchema
        .parse((await w.b.get("/v1/workspace/files")).json)
        .entries.map((e) => e.name),
    ).toEqual(["bobs.txt"]);
    expect(
      workspaceListResponseSchema
        .parse((await w.a.get("/v1/workspace/files")).json)
        .entries.map((e) => e.name),
    ).toEqual(["secret.txt"]);
  });

  it("requires a session", async () => {
    const anon = new TestBrowser(app, PUBLIC_URL);
    expect((await anon.get("/v1/workspace/files")).status).toBe(401);
    expect((await anon.get("/v1/workspace/file?path=a")).status).toBe(401);
  });
});

describe("GET /v1/workspace/file (download)", () => {
  it("streams the current version as an attachment, nosniff, with an audit row", async () => {
    const w = await world();
    await seed(w, w.alice, 'dir/résumé "v1".txt', "hello bytes");
    const res = await w.a.get(
      `/v1/workspace/file?path=${encodeURIComponent('dir/résumé "v1".txt')}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("hello bytes");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(
      /^attachment; filename="r_sum_ _v1_\.txt"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20%22v1%22\.txt$/,
    );
    expect(await auditRows(w.team, "workspace.file_downloaded")).toEqual([
      { userId: w.alice.id, bytes: 11 },
    ]);
  });

  it("serves the newest content after an edit", async () => {
    const w = await world();
    await seed(w, w.alice, "f.txt", "one");
    await seed(w, w.alice, "f.txt", "two!");
    expect((await w.a.get("/v1/workspace/file?path=f.txt")).text).toBe("two!");
  });

  it("resolves against the manifest only: traversal, folders, deleted and unknown paths", async () => {
    const w = await world();
    await seed(w, w.alice, "d/x.txt", "x");
    for (const bad of ["../etc/passwd", "d/../d/x.txt", "/d/x.txt", ""]) {
      const res = await w.a.get(`/v1/workspace/file?path=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await w.a.get("/v1/workspace/file")).status).toBe(400);
    for (const missing of ["d", "d/y.txt", "nope"]) {
      const res = await w.a.get(`/v1/workspace/file?path=${missing}`);
      expect(res.status, missing).toBe(404);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("not_found");
    }
    await w.a.request("DELETE", "/v1/workspace/files?path=d/x.txt");
    expect((await w.a.get("/v1/workspace/file?path=d/x.txt")).status).toBe(404);
  });

  it("never serves agent-internal paths (.kobe/), like list and delete", async () => {
    const w = await world();
    // The sync never stores .kobe/ (it is excluded): plant a row as a guard against that changing.
    await seed(w, w.alice, "state.json", "agent state");
    await fx.admin.query(
      `UPDATE workspace_files SET path = '.kobe/state.json' WHERE team_id = $1 AND path = 'state.json'`,
      [w.team],
    );
    for (const path of [".kobe", ".kobe/state.json"]) {
      const res = await w.a.get(`/v1/workspace/file?path=${encodeURIComponent(path)}`);
      expect(res.status, path).toBe(404);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("not_found");
    }
    expect(await auditRows(w.team, "workspace.file_downloaded")).toEqual([]);
  });

  it("cannot read a teammate's file, even by exact path", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    const res = await w.b.get("/v1/workspace/file?path=secret.txt");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("alice only");
    expect(await auditRows(w.team, "workspace.file_downloaded")).toEqual([]);
  });

  it("a missing object is content_missing (not not_found), and marked for the sandbox to resend (KOBE-475)", async () => {
    const w = await world();
    await seed(w, w.alice, "lost.txt", "poof");
    const hash = sha(Buffer.from("poof"));
    objects.lost.add(workspaceBlobKey("", { teamId: w.team, userId: w.alice.id }, hash));
    const res = await w.a.get("/v1/workspace/file?path=lost.txt");
    expect(res.status).toBe(503);
    expect(workspaceFileErrorSchema.parse(res.json).code).toBe("content_missing");
    const { rows } = await fx.admin.query<{ lost: boolean }>(
      `SELECT lost_at IS NOT NULL AS lost FROM workspace_blobs
        WHERE team_id = $1 AND user_id = $2 AND sha256 = $3`,
      [w.team, w.alice.id, hash],
    );
    expect(rows).toEqual([{ lost: true }]);
  });

  it("a missing project object is content_missing but not marked (no sandbox can resend it)", async () => {
    const w = await world();
    await seed(w, w.alice, "projects/p/spec.md", "spec", "projects");
    for (const key of objects.objects.keys()) {
      if (key.startsWith(`teams/${w.team}/projects/`)) objects.lost.add(key);
    }
    const res = await w.a.get("/v1/workspace/file?path=projects/p/spec.md");
    expect(res.status).toBe(503);
    expect(workspaceFileErrorSchema.parse(res.json).code).toBe("content_missing");
    const { rows } = await fx.admin.query(`SELECT 1 FROM workspace_blobs WHERE team_id = $1`, [
      w.team,
    ]);
    expect(rows).toEqual([]);
  });
});

describe("GET /v1/workspace/files/search (KOBE-223)", () => {
  const search = async (b: TestBrowser, query: string) => {
    const res = await b.get(`/v1/workspace/files/search${query}`);
    expect(res.status, res.text).toBe(200);
    return workspaceSearchResponseSchema.parse(res.json).entries.map((e) => e.path);
  };

  it("lists the caller's own live files whose path contains the query, names first", async () => {
    const w = await world();
    await seed(w, w.alice, "sales/summary.txt", "s");
    await seed(w, w.alice, "reports/Sales Q3.csv", "q");
    await seed(w, w.alice, "notes.md", "n");
    await seed(w, w.alice, "uploads/t/sales-upload.txt", "u", "uploads");
    await seed(w, w.alice, "old-sales.txt", "o");
    await withTeam(fx.db, w.team, (tx) =>
      sync.deleteServerFile(tx, { teamId: w.team, userId: w.alice.id }, "old-sales.txt"),
    );
    await seed(w, w.bob, "bob-sales.csv", "b");
    const found = await search(w.a, "?q=SALES");
    expect(new Set(found)).toEqual(
      new Set(["sales/summary.txt", "reports/Sales Q3.csv", "uploads/t/sales-upload.txt"]),
    );
    // Names starting with the query come before paths that only contain it.
    expect(found.indexOf("sales/summary.txt")).toBe(2);
    expect(await search(w.a, "")).toHaveLength(4);
    expect(await search(w.a, "?limit=1")).toHaveLength(1);
    expect(await search(w.b, "?q=sales")).toEqual(["bob-sales.csv"]);
  });

  it("leaves out names that cannot be mentioned, agent-internal files and other teams' rows", async () => {
    const w = await world();
    const tags = [..."Ignore"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    await seed(w, w.alice, "rep/ok.csv", "o");
    await seed(w, w.alice, `rep/q4.csv${tags}`, "t");
    await seed(w, w.alice, "rep/zero\u200bwidth.csv", "z");
    await seed(w, w.alice, "rep/$(curl x).csv", "d");
    // Never synced; a stray row must still not be offered.
    await fx.admin.query(
      `INSERT INTO workspace_files (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, '.kobe/rep.jsonl', 999999, false, $3, 'k/x', 1, 1, 'sandbox')`,
      [w.team, w.alice.id, "b".repeat(64)],
    );
    const other = await fx.team(`w2-${randomBytes(3).toString("hex")}`, w.alice, []);
    await seed({ ...w, team: other }, w.alice, "rep/elsewhere.csv", "e");
    await fx.activate(w.alice, w.team);
    w.a.team = w.team;
    expect(await search(w.a, "?q=rep")).toEqual(["rep/ok.csv"]);
  });

  it("reads at most the scan bound of rows, tombstones included", async () => {
    const w = await world();
    const owner = { teamId: w.team, userId: w.alice.id };
    for (const p of ["a1.txt", "a2.txt", "a3.txt"]) {
      await seed(w, w.alice, p, p);
      await withTeam(fx.db, w.team, (tx) => sync.deleteServerFile(tx, owner, p));
    }
    await seed(w, w.alice, "b-live.txt", "b");
    const found = (scanMax: number) =>
      withTeam(fx.db, w.team, (tx) => searchFiles(tx, owner, "", 50, scanMax));
    // The three tombstones fill a bound of 3: the live file after them is not reached.
    expect(await found(3)).toEqual([]);
    expect((await found(4)).map((e) => e.path)).toEqual(["b-live.txt"]);
  });

  it("is rate-limited per member (429 rate_limited)", async () => {
    const w = await world();
    await fx.admin.query(
      `INSERT INTO kobe_rate_limits (key, count, window_start, expires_at) VALUES ($1, $2, $3, $3::bigint + 3600000)
       ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, window_start = EXCLUDED.window_start, expires_at = EXCLUDED.expires_at`,
      [`kobe:workspace-search:${w.alice.id}`, SEARCH_RATE_LIMIT.max, Date.now()],
    );
    const res = await w.a.get("/v1/workspace/files/search?q=a");
    expect(res.status).toBe(429);
    expect(res.json.code).toBe("rate_limited");
    expect((await w.b.get("/v1/workspace/files/search?q=a")).status).toBe(200);
  });

  it("answers file entries with their area, and refuses bad queries", async () => {
    const w = await world();
    await seed(w, w.alice, "projects/p/brief.md", "p", "projects");
    const res = await w.a.get("/v1/workspace/files/search?q=brief");
    expect(workspaceSearchResponseSchema.parse(res.json).entries).toMatchObject([
      { path: "projects/p/brief.md", type: "file", area: "projects", owner: "server" },
    ]);
    for (const q of ["?q=%00", `?q=${"a".repeat(101)}`, "?limit=51", "?limit=x", "?path=a"]) {
      expect((await w.a.get(`/v1/workspace/files/search${q}`)).status, q).toBe(400);
    }
  });
});
