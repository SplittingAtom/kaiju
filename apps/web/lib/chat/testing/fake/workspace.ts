/** The caller's workspace files (KOBE-194/223/462/491/496/599) (KOBE-717 area). */
import { sha256Hex } from "../../../files/editor";
import type { FakeCore } from "./core";
import { error, json, NOW, type FakeAnswer, type FakeRequest } from "./state";

/** One folder's files (the root's too), each with its synced version (KOBE-462/491). */
export async function listWorkspace(k: FakeCore, dir: string): Promise<Response> {
  const inDir = (path: string) =>
    dir === ""
      ? !path.includes("/")
      : path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/");
  const files = [...k.workspaceFiles].filter(([path]) => inDir(path));
  const entries = await Promise.all(
    files.map(async ([path, bytes]) => ({
      name: path.split("/").at(-1),
      path,
      type: "file",
      size_bytes: bytes.length,
      mtime: NOW,
      source: "synced",
      owner: "server",
      area: "uploads",
      sha256: await sha256Hex(bytes),
    })),
  );
  const dirs = [...k.workspaceDirs].filter(inDir).map((path) => ({
    name: path.split("/").at(-1),
    path,
    type: "dir",
    size_bytes: null,
    mtime: NOW,
    source: "synced",
    owner: "sandbox",
    area: "workspace",
  }));
  return json(200, { path: dir, entries: [...dirs, ...entries] });
}

/** The editor's save (FE4): replaces the file when it still has `base_sha256`, else 409. */
export async function saveWorkspaceFile(k: FakeCore, url: URL, raw: unknown): Promise<Response> {
  await k.saveGate;
  const path = url.searchParams.get("path") ?? "";
  // No base: the save creates a new file (KOBE-591); it conflicts with a live file.
  const base = url.searchParams.get("base_sha256") ?? "";
  const current = k.workspaceFiles.get(path);
  const currentSha = current === undefined ? undefined : await sha256Hex(current);
  if (base === "" ? current !== undefined : currentSha !== base) {
    return json(409, {
      code: "version_conflict",
      message: "The file changed since you opened it.",
      current:
        current === undefined
          ? null
          : { sha256: currentSha, size_bytes: current.length, mtime: "2026-10-21T00:00:00.000Z" },
    });
  }
  const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(String(raw ?? ""));
  k.workspaceFiles.set(path, new Uint8Array(bytes));
  k.workspaceSaves.push({ path, base, text: new TextDecoder().decode(bytes) });
  return json(200, {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "file",
    size_bytes: bytes.length,
    mtime: "2026-10-21T00:00:00.000Z",
    source: "synced",
    owner: "server",
    area: "workspace",
    sha256: await sha256Hex(bytes),
  });
}

/** Answers its paths; undefined for any other. */
export function workspaceArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url } = req;
  if (url.pathname === "/v1/workspace/files/search" && method === "GET") {
    // KOBE-223: path contains q (case-insensitive), names starting with it first.
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const name = (path: string) => path.split("/").at(-1) ?? "";
    const entries = [...k.workspaceFiles]
      .filter(([path]) => path.toLowerCase().includes(q))
      .sort(
        ([a], [b]) =>
          Number(name(b).toLowerCase().startsWith(q)) - Number(name(a).toLowerCase().startsWith(q)),
      )
      .slice(0, limit)
      .map(([path, bytes]) => ({
        name: name(path),
        path,
        type: "file",
        size_bytes: bytes.length,
        mtime: NOW,
        source: "synced",
        owner: path.startsWith("uploads/") || path.startsWith("projects/") ? "server" : "sandbox",
        area: path.startsWith("uploads/")
          ? "uploads"
          : path.startsWith("projects/")
            ? "projects"
            : "workspace",
      }));
    return json(200, { entries });
  }
  if (url.pathname === "/v1/workspace/file-threads" && method === "GET") {
    return k.fileLinks.route(url) ?? error(404, "not_found");
  }
  if (url.pathname === "/v1/workspace/sync" && method === "POST") {
    return k.workspaceEvents.sync().then((synced) => json(200, synced));
  }
  if (url.pathname === "/v1/workspace/files" && method === "GET") {
    const dir = url.searchParams.get("path") ?? "";
    k.workspaceListings.push(dir);
    return listWorkspace(k, dir);
  }
  if (url.pathname === "/v1/workspace/files" && method === "DELETE") {
    const path = url.searchParams.get("path") ?? "";
    k.workspaceDeletes.push(path);
    if (!k.workspaceFiles.delete(path)) return error(404, "not_found");
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/v1/workspace/file" && method === "PUT") {
    return saveWorkspaceFile(k, url, req.raw);
  }
  if (url.pathname === "/v1/workspace/file" && method === "GET") {
    const bytes = k.workspaceFiles.get(url.searchParams.get("path") ?? "");
    if (!bytes) return error(404, "not_found");
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }
  return undefined;
}
