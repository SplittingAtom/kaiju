import { describe, expect, it } from "vitest";
import {
  workspaceFileEntrySchema,
  workspaceFileErrorSchema,
  workspaceListResponseSchema,
} from "@kaiju/protocol";
import { type WorkspaceChange } from "@kaiju/protocol/sandbox-wire";
import { withTeam } from "@kaiju/db";
import { createApp } from "../app.js";
import { PUBLIC_URL, must } from "../testing/event-stream-fixture.js";
import { TestBrowser } from "../testing/browser.js";
import { commitChanges } from "../workspace-sync/store.js";
import { OPERATION_LIMITS } from "../operation-limits.js";
import { expectRateLimited, fillLimit } from "../testing/operation-limits.js";
import { limitsQuota, workspaceBlobKey, type WorkspaceSync } from "../workspace-sync/index.js";
import {
  fx,
  objects,
  LIMITS,
  woken,
  sync,
  app,
  type World,
  browserFor,
  world,
  sha,
  seed,
  multipart,
  upload,
  auditRows,
  useWorkspaceFilesWorld,
} from "./workspace-files.test-helpers.js";

useWorkspaceFilesWorld();

describe("POST /v1/workspace/files (upload)", () => {
  it("stores the file under the folder, as a server write the sandbox will pull", async () => {
    const w = await world();
    const res = await upload(w.a, "docs/in", "plan.txt", "the plan");
    expect(res.status, res.text).toBe(201);
    const entry = workspaceFileEntrySchema.parse(res.json);
    expect(entry).toMatchObject({
      name: "plan.txt",
      path: "docs/in/plan.txt",
      type: "file",
      size_bytes: 8,
      source: "synced",
      area: "workspace",
      sha256: sha(Buffer.from("the plan")),
    });
    const { rows } = await fx.admin.query<{ origin: string; rev: string; blob_key: string }>(
      `SELECT origin, rev, blob_key FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = $3`,
      [w.team, w.alice.id, "docs/in/plan.txt"],
    );
    expect(rows[0]).toMatchObject({ origin: "server" });
    expect(objects.objects.get(must(rows[0], "row").blob_key)?.toString()).toBe("the plan");
    expect((await w.a.get("/v1/workspace/file?path=docs/in/plan.txt")).text).toBe("the plan");
    expect(await auditRows(w.team, "workspace.file_uploaded")).toEqual([
      { userId: w.alice.id, bytes: 8 },
    ]);
  });

  it("uploads to the root when no folder is given", async () => {
    const w = await world();
    const res = await upload(w.a, undefined, "top.txt", "t");
    expect(res.status).toBe(201);
    expect(workspaceFileEntrySchema.parse(res.json).path).toBe("top.txt");
  });

  it("does not overwrite: an existing file, a folder or a file in the way is already_exists", async () => {
    const w = await world();
    await seed(w, w.alice, "a/b.txt", "b");
    await seed(w, w.alice, "flat", "f");
    for (const [folder, name] of [
      ["a", "b.txt"], // same file
      ["", "a"], // a folder with that name
      ["flat", "x.txt"], // a file where the folder would go
    ] as const) {
      const res = await upload(w.a, folder, name, "new");
      expect(res.status, `${folder}/${name}`).toBe(409);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("already_exists");
    }
    expect((await w.a.get("/v1/workspace/file?path=a/b.txt")).text).toBe("b");
  });

  it("refuses the server-owned areas and the agent-internal one", async () => {
    const w = await world();
    for (const folder of ["uploads/t1", "projects", "projects/p", ".kaiju", ".kaiju/s"]) {
      const res = await upload(w.a, folder, "x.txt", "x");
      expect(res.status, folder).toBe(folder.startsWith(".kaiju") ? 400 : 403);
    }
    expect(
      workspaceFileErrorSchema.parse((await upload(w.a, "uploads/t1", "x", "x")).json).code,
    ).toBe("read_only");
  });

  it("validates the request: file name, folder, fields, parts, length", async () => {
    const w = await world();
    expect((await upload(w.a, "../up", "x.txt", "x")).status).toBe(400);
    const none = multipart({ path: "a" });
    expect((await w.a.request("POST", "/v1/workspace/files", none.raw, none.headers)).status).toBe(
      400,
    );
    const extra = multipart({ path: "a", other: "1" }, { name: "x", data: "x" });
    expect(
      (await w.a.request("POST", "/v1/workspace/files", extra.raw, extra.headers)).status,
    ).toBe(400);
    const m = multipart({}, { name: "x", data: "x" });
    expect((await w.a.request("POST", "/v1/workspace/files", m.raw)).status).toBe(411);
    const json = await w.a.request("POST", "/v1/workspace/files", { path: "a" });
    expect(json.status).toBe(415);
  });

  it("enforces the file size limit and the workspace quota", async () => {
    const w = await world();
    const big = await upload(w.a, "", "big.bin", "x".repeat(LIMITS.maxFileBytes + 1));
    expect(big.status).toBe(413);
    expect(workspaceFileErrorSchema.parse(big.json).code).toBe("file_too_large");
    const tiny = createApp(fx.replica(0).deps, {
      workspaceFiles: {
        sync: Object.assign(Object.create(sync) as WorkspaceSync, {
          quota: limitsQuota({ ...LIMITS, maxFiles: 1 }),
        }),
        waker: { wake: () => Promise.resolve() },
      },
    });
    const b = new TestBrowser(tiny, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) b.cookies.set(k, v);
    b.team = w.team;
    expect((await upload(b, "", "one.txt", "1")).status).toBe(201);
    const second = await upload(b, "", "two.txt", "2");
    expect(second.status).toBe(507);
    expect(workspaceFileErrorSchema.parse(second.json).code).toBe("quota_exceeded");
  });

  it("keeps a concurrent sandbox edit as a conflict (the sandbox's stale write is not applied)", async () => {
    const w = await world();
    const owner = { teamId: w.team, userId: w.alice.id };
    const hash = sha(Buffer.from("sandbox edit"));
    const stale: WorkspaceChange = {
      op: "put",
      path: "doc.txt",
      base_rev: null,
      sha256: hash,
      size: 12,
      mtime_ms: Date.now(),
      executable: false,
    };
    expect((await upload(w.a, "", "doc.txt", "from browser")).status).toBe(201);
    const outcome = await withTeam(fx.db, w.team, (tx) =>
      commitChanges(tx, owner, [stale], {
        prefix: "",
        quota: sync.quota,
        maxRows: 100,
      }),
    );
    expect(outcome.results[0]).toMatchObject({ status: "conflict", path: "doc.txt" });
    expect((await w.a.get("/v1/workspace/file?path=doc.txt")).text).toBe("from browser");
  });

  it("streams through the uploads pipeline: putStream, no buffered put, no staging object left", async () => {
    const w = await world();
    const original = { put: objects.put, putStream: objects.putStream };
    let streamed = 0;
    let buffered = 0;
    objects.put = (...args) => {
      buffered += 1;
      return original.put.apply(objects, args);
    };
    objects.putStream = (...args) => {
      streamed += 1;
      return original.putStream.apply(objects, args);
    };
    try {
      const res = await upload(w.a, "s", "big.bin", "y".repeat(5000));
      expect(res.status, res.text).toBe(201);
    } finally {
      Object.assign(objects, original);
    }
    expect(streamed).toBe(1);
    expect(buffered).toBe(0);
    const owner = { teamId: w.team, userId: w.alice.id };
    expect(objects.keys(`teams/${w.team}/users/${w.alice.id}/workspace/`)).toEqual([
      workspaceBlobKey("", owner, sha(Buffer.from("y".repeat(5000)))),
    ]);
  });

  it("cuts an oversized body off mid-stream and leaves no object or row", async () => {
    const w = await world();
    const before = objects.objects.size;
    const m = multipart({}, { name: "huge.bin", data: "z".repeat(LIMITS.maxFileBytes + 10) });
    // The declared length lies (fits the limit), so only the meter can stop the body.
    const res = await w.a.request("POST", "/v1/workspace/files", m.raw, {
      "content-length": "1000",
    });
    expect([400, 413]).toContain(res.status);
    expect(objects.objects.size).toBe(before);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM workspace_files WHERE team_id = $1 AND path = 'huge.bin'`,
      [w.team],
    );
    expect(rows).toEqual([]);
  });

  it("counts against the team storage quota (KOBE-143) and cleans up when over it", async () => {
    const w = await world();
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 10, $2)`,
      [w.team, w.alice.id],
    );
    const before = objects.objects.size;
    expect((await upload(w.a, "", "ok.txt", "12345")).status).toBe(201);
    const over = await upload(w.a, "", "over.txt", "1234567");
    expect(over.status).toBe(507);
    expect(workspaceFileErrorSchema.parse(over.json).code).toBe("quota_exceeded");
    // The refused content stays as an unreferenced workspace blob (the collector's job, KOBE-27);
    // no staging object is left either way.
    expect(objects.objects.size).toBe(before + 2);
    expect(objects.keys().filter((k) => k.includes("/incoming/"))).toEqual([]);
  });

  it("reuses content a workspace already holds (no second object)", async () => {
    const w = await world();
    await seed(w, w.alice, "orig.txt", "same bytes");
    const before = objects.objects.size;
    expect((await upload(w.a, "", "copy.txt", "same bytes")).status).toBe(201);
    expect(objects.objects.size).toBe(before);
  });
});

describe("DELETE /v1/workspace/files", () => {
  it("tombstones a file in the manifest (rev bumped, sandbox pulls it) and audits counts only", async () => {
    const w = await world();
    await seed(w, w.alice, "x/del.txt", "12345");
    const res = await w.a.request("DELETE", "/v1/workspace/files?path=x/del.txt");
    expect(res.status).toBe(204);
    const { rows } = await fx.admin.query<{ deleted: boolean; origin: string; size: string }>(
      `SELECT deleted, origin, size FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = 'x/del.txt'`,
      [w.team, w.alice.id],
    );
    expect(rows[0]).toMatchObject({ deleted: true, origin: "server", size: "5" });
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([
      { userId: w.alice.id, files: 1, bytes: 5 },
    ]);
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=x/del.txt")).status).toBe(404);
  });

  it("deletes a folder's files together", async () => {
    const w = await world();
    await seed(w, w.alice, "tree/a", "1");
    await seed(w, w.alice, "tree/sub/b", "22");
    await seed(w, w.alice, "treehouse", "keep");
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=tree")).status).toBe(204);
    const list = workspaceListResponseSchema.parse((await w.a.get("/v1/workspace/files")).json);
    expect(list.entries.map((e) => e.name)).toEqual(["treehouse"]);
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([
      { userId: w.alice.id, files: 2, bytes: 3 },
    ]);
  });

  it("refuses project mounts and uploads (read only), and the root", async () => {
    const w = await world();
    await seed(w, w.alice, "projects/p/readme.md", "r", "projects");
    await seed(w, w.alice, "uploads/t/f.txt", "u", "uploads");
    for (const path of [
      "projects/p/readme.md",
      "projects/p",
      "projects",
      "uploads/t/f.txt",
      "uploads",
    ]) {
      const res = await w.a.request("DELETE", `/v1/workspace/files?path=${path}`);
      expect(res.status, path).toBe(403);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("read_only");
    }
    expect((await w.a.get("/v1/workspace/file?path=projects/p/readme.md")).status).toBe(200);
    expect((await w.a.request("DELETE", "/v1/workspace/files")).status).toBe(400);
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=")).status).toBe(400);
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([]);
  });

  it("cannot delete a teammate's file", async () => {
    const w = await world();
    await seed(w, w.alice, "secret.txt", "alice only");
    expect((await w.b.request("DELETE", "/v1/workspace/files?path=secret.txt")).status).toBe(404);
    expect((await w.a.get("/v1/workspace/file?path=secret.txt")).text).toBe("alice only");
  });

  it("is refused while a legal hold covers the user", async () => {
    const w = await world();
    await seed(w, w.alice, "evidence.txt", "keep me");
    // The two-person flow has its own tests (KOBE-17); the guard trigger is bypassed to get a hold.
    await fx.admin.query("SET session_replication_role = replica");
    try {
      await fx.admin.query(
        `INSERT INTO legal_holds (team_id, user_id, reason, status, placed_by, approved_by, approved_at, self_approved)
         VALUES ($1, $2, 'matter 148', 'active', $3, $3, now(), true)`,
        [w.team, w.alice.id, w.bob.id],
      );
    } finally {
      await fx.admin.query("SET session_replication_role = DEFAULT");
    }
    const res = await w.a.request("DELETE", "/v1/workspace/files?path=evidence.txt");
    expect(res.status).toBe(409);
    expect(workspaceFileErrorSchema.parse(res.json).code).toBe("legal_hold");
    expect((await w.a.get("/v1/workspace/file?path=evidence.txt")).text).toBe("keep me");
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([]);
  });

  it("requires the team header on changes (multi-tab guard)", async () => {
    const w = await world();
    const stray = new TestBrowser(app, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) stray.cookies.set(k, v);
    expect((await stray.request("DELETE", "/v1/workspace/files?path=a")).status).toBe(400);
  });
});

describe("rail drop into uploads/ (KOBE-199)", () => {
  const THREAD = "0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";
  const uploadRows = async (w: World) =>
    (
      await fx.admin.query<{ path: string }>(
        `SELECT path FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path LIKE 'uploads/%' AND NOT deleted ORDER BY path`,
        [w.team, w.alice.id],
      )
    ).rows.map((r) => r.path);

  it("stores a direct child of uploads/ as a server write, audited like any upload", async () => {
    const w = await world();
    const res = await upload(w.a, "uploads", "brief.pdf", "pdf!");
    expect(res.status, res.text).toBe(201);
    expect(workspaceFileEntrySchema.parse(res.json)).toMatchObject({
      path: "uploads/brief.pdf",
      area: "uploads",
      size_bytes: 4,
    });
    const { rows } = await fx.admin.query<{ origin: string }>(
      `SELECT origin FROM workspace_files WHERE team_id = $1 AND user_id = $2 AND path = 'uploads/brief.pdf'`,
      [w.team, w.alice.id],
    );
    expect(rows[0]).toMatchObject({ origin: "server" });
    expect(await auditRows(w.team, "workspace.file_uploaded")).toEqual([
      { userId: w.alice.id, bytes: 4, area: "drop" },
    ]);
    expect((await w.a.get("/v1/workspace/file?path=uploads/brief.pdf")).text).toBe("pdf!");
  });

  it("refuses nested paths, thread folders and UUID-shaped names, lookalikes too", async () => {
    const w = await world();
    await seed(w, w.alice, `uploads/${THREAD}/a.txt`, "a", "uploads");
    for (const folder of [`uploads/${THREAD}`, "uploads/new", "uploads/a/b"]) {
      const res = await upload(w.a, folder, "x.txt", "x");
      expect(res.status, folder).toBe(403);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("read_only");
    }
    for (const name of [THREAD, THREAD.toUpperCase(), ` ${THREAD} `, `${THREAD}\u200d`]) {
      const res = await upload(w.a, "uploads", name, "x");
      expect(res.status, name).toBe(400);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("invalid_path");
    }
    expect(await uploadRows(w)).toEqual([`uploads/${THREAD}/a.txt`]);
  });

  it("never overwrites: a clash takes the next free copy name, chosen by the server", async () => {
    const w = await world();
    await seed(w, w.alice, "uploads/notes.txt", "old", "uploads");
    await seed(w, w.alice, "uploads/notes (1).txt", "older", "uploads");
    await seed(w, w.alice, "uploads/legacy/f.txt", "f", "uploads");
    for (const [name, path] of [
      ["notes.txt", "uploads/notes (2).txt"],
      ["legacy", "uploads/legacy (1)"],
    ] as const) {
      const res = await upload(w.a, "uploads", name, "new");
      expect(res.status, name).toBe(201);
      expect(workspaceFileEntrySchema.parse(res.json).path).toBe(path);
    }
    expect((await w.a.get("/v1/workspace/file?path=uploads/notes.txt")).text).toBe("old");
    expect((await w.a.get("/v1/workspace/file?path=uploads/notes (2).txt")).text).toBe("new");
    // Outside uploads/ a clash is still refused (the file browser's own upload).
    await seed(w, w.alice, "a.txt", "a");
    expect((await upload(w.a, undefined, "a.txt", "b")).status).toBe(409);
  });

  it("gives two concurrent drops of one name distinct names", async () => {
    const w = await world();
    const [one, two] = await Promise.all([
      upload(w.a, "uploads", "same.txt", "first"),
      upload(w.a, "uploads", "same.txt", "second"),
    ]);
    expect([one.status, two.status]).toEqual([201, 201]);
    const paths = [one, two].map((r) => workspaceFileEntrySchema.parse(r.json).path).sort();
    expect(paths).toEqual(["uploads/same (1).txt", "uploads/same.txt"]);
    expect(await uploadRows(w)).toEqual(paths);
  });

  it("deletes a dropped file, but never a folder or a thread's files in uploads/", async () => {
    const w = await world();
    expect((await upload(w.a, "uploads", "oops.txt", "x")).status).toBe(201);
    await seed(w, w.alice, `uploads/${THREAD}/a.txt`, "a", "uploads");
    await seed(w, w.alice, "uploads/legacy/f.txt", "f", "uploads");
    for (const path of [`uploads/${THREAD}`, `uploads/${THREAD}/a.txt`, "uploads"]) {
      const res = await w.a.request("DELETE", `/v1/workspace/files?path=${path}`);
      expect(res.status, path).toBe(403);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("read_only");
    }
    // A drop path deletes that one file only: a folder of the same name is not a drop.
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=uploads/legacy")).status).toBe(
      404,
    );
    expect((await w.a.request("DELETE", "/v1/workspace/files?path=uploads/oops.txt")).status).toBe(
      204,
    );
    expect(await uploadRows(w)).toEqual([`uploads/${THREAD}/a.txt`, "uploads/legacy/f.txt"]);
    expect(await auditRows(w.team, "workspace.file_deleted")).toEqual([
      { userId: w.alice.id, files: 1, bytes: 1 },
    ]);
  });

  it("stays in the caller's own workspace: no other team, no teammate's file", async () => {
    const w = await world();
    const other = await world();
    // Not her team: refused before any write (the session's team never matches).
    const res = await upload(browserFor(w.alice, other.team), "uploads", "in.txt", "x");
    expect(res.status).toBe(409);
    expect((res.json as { code: string }).code).toBe("team_mismatch");
    expect((await upload(w.a, "uploads", "mine.txt", "x")).status).toBe(201);
    expect((await w.b.request("DELETE", "/v1/workspace/files?path=uploads/mine.txt")).status).toBe(
      404,
    );
    expect(await uploadRows(w)).toEqual(["uploads/mine.txt"]);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM workspace_files WHERE team_id = $1 AND path LIKE 'uploads/%'`,
      [other.team],
    );
    expect(rows).toEqual([]);
  });
});

describe("POST /v1/workspace/files under the upload limit (KOBE-813)", () => {
  it("shares the composer's upload bucket, one hit per file", async () => {
    const w = await world();
    const limit = OPERATION_LIMITS.upload;
    await fillLimit(fx.admin, limit, w.alice.id);
    expectRateLimited(await upload(w.a, undefined, "limited.txt", "hi"), limit);
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM workspace_files WHERE team_id = $1 AND path = 'limited.txt'`,
      [w.team],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("POST /v1/workspace/wake", () => {
  it("asks the lifecycle to wake the caller's own sandbox and answers at once", async () => {
    const w = await world();
    const res = await w.a.post("/v1/workspace/wake");
    expect(res.status).toBe(202);
    expect(woken.at(-1)).toEqual({ teamId: w.team, userId: w.alice.id });
    await w.b.post("/v1/workspace/wake");
    expect(woken.at(-1)).toEqual({ teamId: w.team, userId: w.bob.id });
  });

  it("refuses past the member's wake limit without waking (KOBE-813)", async () => {
    const w = await world();
    const limit = OPERATION_LIMITS.sandboxWake;
    await fillLimit(fx.admin, limit, w.alice.id);
    const before = woken.length;
    expectRateLimited(await w.a.post("/v1/workspace/wake"), limit);
    expect(woken).toHaveLength(before);
    expect((await w.b.post("/v1/workspace/wake")).status).toBe(202);
  });
});

describe("without object storage", () => {
  it("answers 503 sandbox_unavailable on every route", async () => {
    const w = await world();
    const bare = createApp(fx.replica(0).deps);
    const b = new TestBrowser(bare, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) b.cookies.set(k, v);
    b.team = w.team;
    for (const res of [
      await b.get("/v1/workspace/files"),
      await b.get("/v1/workspace/file?path=a"),
      await b.post("/v1/workspace/wake"),
    ]) {
      expect(res.status).toBe(503);
      expect(workspaceFileErrorSchema.parse(res.json).code).toBe("sandbox_unavailable");
    }
  });
});
