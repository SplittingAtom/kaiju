import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  audits,
  fx,
  multipart,
  projectUpload,
  rows,
  save,
  settle,
  sha,
  workspaceUpload,
  world,
  type World,
} from "./testing/project-commits-fixture.js";
import type { TestBrowser } from "./testing/browser.js";

/**
 * KOBE-780 against a real Postgres: the path rules of every write of a project's files. P2-8: a
 * path must still fit the 1024-byte workspace limit once mounted as `projects/<slug>/<path>`, and
 * a row from before that rule never stops the project's other files reaching members. P2-9: no
 * file inside a file. P2-41: an archived project's files stay. P2-43: only real conflict copies
 * are refused.
 */

// Four 240-byte folders: with a 60-byte name the path is 1024 bytes, valid on its own but too
// long under `projects/<slug>/`.
const LONG_FOLDER = Array.from({ length: 4 }, () => "a".repeat(240)).join("/");
const LONG_NAME = "b".repeat(60);

function upload(b: TestBrowser, projectId: string, name: string, content: string, folder?: string) {
  const { body, bytes } = multipart(name, content, folder);
  return b.request("POST", `/v1/projects/${projectId}/files`, body, {
    "content-length": String(bytes.length),
  });
}

const files = async (w: World) =>
  (await w.as.alice.get(`/v1/projects/${w.project.id}/files`)).json.files as {
    id: string;
    path: string;
    path_too_long?: boolean;
  }[];

describe("mount path length (P2-8)", () => {
  it("refuses an Add to project whose mounted path would be too long", async () => {
    const w = await world();
    const id = w.project.id;
    // (A multipart upload's folder field is capped at 256 bytes, so it cannot get this long.)
    expect((await upload(w.as.alice, id, LONG_NAME, "x", LONG_FOLDER)).status).toBe(400);
    expect((await workspaceUpload(w.as.alice, "notes", LONG_NAME, "x")).status).toBe(201);
    const imported = await w.as.alice.post(`/v1/projects/${id}/files/import`, {
      source: { kind: "workspace_file", path: `notes/${LONG_NAME}` },
      folder: LONG_FOLDER,
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(422);
    expect(imported.json).toMatchObject({ code: "invalid_input" });
    expect(String(imported.json.message)).toContain("too long");
    expect(await files(w)).toEqual([]);
  });

  it("keeps mounting, checking out and committing around a row from before the rule", async () => {
    const w = await world();
    const { id, slug } = w.project;
    await projectUpload(w.as.alice, id, "ok.md", "OK1");
    // A row (and head tree entry) that slipped in before the rule: same content, long path.
    const long = `${LONG_FOLDER}/${LONG_NAME}`;
    await fx.admin.query(
      `INSERT INTO project_files (team_id, id, project_id, path, size_bytes, sha256, mime_type,
                                  blob_ref, source, added_by)
       SELECT team_id, $3, project_id, $4, size_bytes, sha256, mime_type, blob_ref, source, added_by
         FROM project_files WHERE team_id = $1 AND project_id = $2`,
      [w.team, id, randomUUID(), long],
    );
    await fx.admin.query(
      `INSERT INTO project_tree_entries (team_id, commit_id, path, sha256, blob_ref, size_bytes,
                                         mime_type, executable)
       SELECT e.team_id, e.commit_id, $3, e.sha256, e.blob_ref, e.size_bytes, e.mime_type, false
         FROM project_tree_entries e JOIN projects p ON p.head_commit_id = e.commit_id
        WHERE e.team_id = $1 AND p.id = $2`,
      [w.team, id, long],
    );
    // The owner sees which file does not reach workspaces.
    const listed = await files(w);
    expect(listed.find((f) => f.path === long)?.path_too_long).toBe(true);
    expect(listed.find((f) => f.path === "ok.md")?.path_too_long).toBeUndefined();

    // Bob's conversation mounts the project: ok.md arrives, the long row is skipped.
    expect((await w.as.bob.post("/v1/threads", { project_id: id })).status).toBe(201);
    await settle();
    expect([...(await rows(w.team, w.people.bob.id, slug)).keys()]).toEqual(["ok.md"]);

    // Checkout works (it skips the row); a commit keeps the file it could not write.
    const co = await w.as.bob.post(`/v1/projects/${id}/checkout`, {});
    expect(co.status, JSON.stringify(co.json)).toBe(200);
    expect((await w.as.bob.get(`/v1/projects/${id}/checkout`)).json.diff).toEqual([]);
    expect((await save(w.as.bob, `projects/${slug}/ok.md`, sha("OK1"), "OK2")).status).toBe(200);
    const c = await w.as.bob.post(`/v1/projects/${id}/commit`, { message: "edit ok" });
    expect(c.json).toMatchObject({ status: "committed", seq: 2 });
    const tree = (await w.as.bob.get(`/v1/projects/${id}/commits/2`)).json.tree as {
      path: string;
    }[];
    expect(tree.map((e) => e.path).sort()).toEqual([long, "ok.md"].sort());

    // Deleting the row is the way out; the delete works like any other.
    const row = (await files(w)).find((f) => f.path === long);
    expect((await w.as.alice.delete(`/v1/projects/${id}/files/${row?.id}`)).status).toBe(204);
  });

  it("refuses to revert to a tree that holds a path too long to mount", async () => {
    const w = await world();
    const { id } = w.project;
    await projectUpload(w.as.alice, id, "ok.md", "OK1");
    const long = `${LONG_FOLDER}/${LONG_NAME}`;
    await fx.admin.query(
      `INSERT INTO project_tree_entries (team_id, commit_id, path, sha256, blob_ref, size_bytes,
                                         mime_type, executable)
       SELECT e.team_id, e.commit_id, $3, e.sha256, e.blob_ref, e.size_bytes, e.mime_type, false
         FROM project_tree_entries e JOIN projects p ON p.head_commit_id = e.commit_id
        WHERE e.team_id = $1 AND p.id = $2`,
      [w.team, id, long],
    );
    await projectUpload(w.as.alice, id, "two.md", "T");
    // The long path is only in commit 1's tree (commit 2 is built from project_files): reverting
    // to 1 would bring it back.
    const res = await w.as.alice.post(`/v1/projects/${id}/commits/1/revert`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(res.json).toMatchObject({ code: "invalid_input" });
  });
});

describe("file inside a file (P2-9)", () => {
  it("refuses an upload or Add to project that would put a file inside a file", async () => {
    const w = await world();
    const id = w.project.id;
    await projectUpload(w.as.alice, id, "docs", "a file named docs");
    const inside = await upload(w.as.alice, id, "a.md", "x", "docs");
    expect(inside.status, JSON.stringify(inside.json)).toBe(409);
    expect(inside.json).toMatchObject({ code: "already_exists" });
    expect(String(inside.json.message)).toContain("folder");
    expect((await upload(w.as.alice, id, "x.md", "x", "lib/sub")).status).toBe(201);
    // A file where a folder is, at both depths.
    expect((await upload(w.as.alice, id, "lib", "x")).status).toBe(409);
    expect((await upload(w.as.alice, id, "sub", "x", "lib")).status).toBe(409);
    // Add to project the same way.
    expect((await workspaceUpload(w.as.alice, "notes", "n.md", "N")).status).toBe(201);
    const imported = await w.as.alice.post(`/v1/projects/${id}/files/import`, {
      source: { kind: "workspace_file", path: "notes/n.md" },
      folder: "docs",
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(409);
    expect((await files(w)).map((f) => f.path).sort()).toEqual(["docs", "lib/sub/x.md"]);
  });
});

describe("archived projects (P2-41)", () => {
  it("refuses deleting a file of an archived project", async () => {
    const w = await world();
    const id = w.project.id;
    const file = await projectUpload(w.as.alice, id, "a.md", "A");
    expect((await w.as.alice.patch(`/v1/projects/${id}`, { archived: true })).status).toBe(200);
    const res = await w.as.alice.delete(`/v1/projects/${id}/files/${file.id}`);
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json).toMatchObject({ code: "archived" });
    expect(await files(w)).toHaveLength(1);
    const commits = await fx.admin.query(`SELECT 1 FROM project_commits WHERE project_id = $1`, [
      id,
    ]);
    expect(commits.rows).toHaveLength(1);
    expect((await w.as.alice.patch(`/v1/projects/${id}`, { archived: false })).status).toBe(200);
    expect((await w.as.alice.delete(`/v1/projects/${id}/files/${file.id}`)).status).toBe(204);
  });
});

describe("conflict copies (P2-43)", () => {
  it("commits ordinary names containing .conflict- and refuses real conflict copies", async () => {
    const w = await world();
    const { id, slug } = w.project;
    const dir = `projects/${slug}`;
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect(
      (await workspaceUpload(w.as.alice, dir, "notes.conflict-resolution.md", "N")).status,
    ).toBe(201);
    const ok = await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "notes" });
    expect(ok.json).toMatchObject({ status: "committed" });
    expect(
      (await workspaceUpload(w.as.alice, dir, "a.conflict-20261101T120000Z.md", "C")).status,
    ).toBe(201);
    const refused = await w.as.alice.post(`/v1/projects/${id}/commit`, { message: "copy" });
    expect(refused.status).toBe(422);
  });
});

describe("team quota checked after the project's counters are written (P2-44)", () => {
  const used = async (team: string) =>
    (
      await fx.admin.query<{ bytes: string; objects: string }>(
        `SELECT (SELECT COALESCE(SUM(live_bytes), 0) FROM workspace_sync WHERE team_id = $1)
              + (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE team_id = $1 AND run_id IS NULL)
              + (SELECT COALESCE(SUM(live_bytes + history_bytes), 0) FROM projects WHERE team_id = $1)
                AS bytes,
                (SELECT COALESCE(SUM(blob_count + pending_blobs), 0) FROM workspace_sync WHERE team_id = $1)
              + (SELECT count(*) FROM files WHERE team_id = $1 AND run_id IS NULL)
              + (SELECT COALESCE(SUM(live_objects + history_objects), 0) FROM projects WHERE team_id = $1)
                AS objects`,
        [team],
      )
    ).rows[0];
  const quota = (w: World, bytes: number | null, objects: number | null) =>
    fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, max_objects, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id) DO UPDATE SET max_bytes = $2, max_objects = $3`,
      [w.team, bytes, objects, w.admin.id],
    );

  it("keeps the upload's byte and object limits exact, and a refusal leaves nothing", async () => {
    const w = await world();
    const id = w.project.id;
    await projectUpload(w.as.alice, id, "a.md", "A");
    const now = await used(w.team);
    const bytes = Number(now?.bytes);
    const objects = Number(now?.objects);
    // Ten bytes more need room for ten: one byte short is refused.
    await quota(w, bytes + 9, null);
    const short = await upload(w.as.alice, id, "b.md", "0123456789");
    expect(short.status, JSON.stringify(short.json)).toBe(507);
    expect(short.json).toMatchObject({ code: "quota_exceeded", limit: "bytes" });
    // One more object needs room for one.
    await quota(w, null, objects);
    const full = await upload(w.as.alice, id, "b.md", "0123456789");
    expect(full.json).toMatchObject({ code: "quota_exceeded", limit: "objects" });
    const commits = await fx.admin.query(`SELECT 1 FROM project_commits WHERE project_id = $1`, [
      id,
    ]);
    expect(commits.rows).toHaveLength(1);
    expect((await used(w.team))?.bytes).toBe(now?.bytes);
    // Exactly enough room for both.
    await quota(w, bytes + 10, objects + 1);
    expect((await upload(w.as.alice, id, "b.md", "0123456789")).status).toBe(201);
  });
});

describe("deleting a project with working copies (P2-42)", () => {
  it("tells the owner who has uncommitted changes and audits what the delete discards", async () => {
    const w = await world();
    const { id, slug } = w.project;
    // An empty project (nothing blocks the delete), checked out by bob with a new file and by
    // alice with none.
    expect((await w.as.bob.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    expect((await workspaceUpload(w.as.bob, `projects/${slug}`, "new.md", "N")).status).toBe(201);
    expect((await w.as.alice.post(`/v1/projects/${id}/checkout`, {})).status).toBe(200);
    const copies = await w.as.alice.get(`/v1/projects/${id}/checkouts`);
    expect(copies.status).toBe(200);
    const byUser = Object.fromEntries(
      (copies.json.checkouts as { user_id: string; changed_files: number }[]).map((c) => [
        c.user_id,
        c.changed_files,
      ]),
    );
    expect(byUser).toEqual({ [w.people.bob.id]: 1, [w.people.alice.id]: 0 });

    // The delete carries how many the owner confirmed; more than that now is a 409 with the count.
    const unconfirmed = await w.as.alice.delete(`/v1/projects/${id}`);
    expect(unconfirmed.status, JSON.stringify(unconfirmed.json)).toBe(409);
    expect(unconfirmed.json).toMatchObject({
      code: "uncommitted_work",
      uncommitted_working_copies: 1,
    });
    // Alice confirmed one, then she starts uncommitted work too: asked again with 2.
    expect((await workspaceUpload(w.as.alice, `projects/${slug}`, "mine.md", "M")).status).toBe(
      201,
    );
    const stale = await w.as.alice.delete(`/v1/projects/${id}?confirmed_uncommitted=1`);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ uncommitted_working_copies: 2 });
    expect((await w.as.alice.delete(`/v1/projects/${id}?confirmed_uncommitted=x`)).status).toBe(
      400,
    );
    expect((await w.as.alice.delete(`/v1/projects/${id}?confirmed_uncommitted=2`)).status).toBe(
      204,
    );
    expect((await audits(w.team, "project.deleted")).at(-1)).toEqual({
      projectId: id,
      workingCopies: 2,
      uncommittedWorkingCopies: 2,
    });
    const discarded = (await audits(w.team, "project.checkout_discarded")).filter(
      (t) => t.reason === "project_deleted",
    );
    expect(discarded.map((t) => t.userId).sort()).toEqual(
      [w.people.alice.id, w.people.bob.id].sort(),
    );
  });
});
