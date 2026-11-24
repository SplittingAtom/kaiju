/** Projects, their files and commits (KOBE-163/585/586/592) (KOBE-717 area). */
import type { ProjectCommit, ProjectFile } from "@kaiju/protocol";
import type { FakeCore } from "./core";
import { error, json, NOW, uuid, type FakeAnswer, type FakeRequest, type Json } from "./state";

export function projectCommits(
  k: FakeCore,
  method: string,
  id: string,
  rest: string[],
  body: Json | undefined,
): Response {
  if (!k.projects.some((p) => p.id === id)) return error(404, "not_found");
  const head = k.projectHeads.get(id) ?? { seq: 0, files: new Map<string, string>() };
  if (method === "GET" && rest.length === 0) {
    const commit: ProjectCommit = {
      id: uuid(11, head.seq),
      project_id: id,
      seq: head.seq,
      parent_id: head.seq > 1 ? uuid(11, head.seq - 1) : null,
      author_user_id: uuid(3, 1),
      author_kind: "user",
      thread_id: null,
      run_id: null,
      message: "Update",
      file_count: head.files.size,
      bytes: 1,
      created_at: NOW,
    };
    const commits = head.seq === 0 ? [] : [commit];
    return json(200, { commits, next_before: null });
  }
  if (method === "GET" && rest[1] === "files") {
    const path = rest.slice(2).map(decodeURIComponent).join("/");
    const text = Number(rest[0]) === head.seq ? head.files.get(path) : undefined;
    if (text === undefined) return error(404, "not_found");
    return new Response(new TextEncoder().encode(text), { status: 200 });
  }
  if (method === "POST" && rest[0] === "from-proposal") {
    k.fromProposalRequests.push(body ?? {});
    const next = k.nextFromProposal;
    k.nextFromProposal = undefined;
    if (next) return json(next.status, next.body);
    return json(200, {
      status: "committed",
      seq: head.seq + 1,
      commit_id: uuid(11, head.seq + 1),
    });
  }
  return error(404, "not_found");
}

export function projectFiles(
  k: FakeCore,
  method: string,
  id: string,
  sub: string | undefined,
  body: Json | undefined,
) {
  if (!k.projects.some((p) => p.id === id)) return error(404, "not_found");
  const held = k.projectFiles.get(id) ?? [];
  const file = (path: string): ProjectFile => ({
    id: uuid(11, held.indexOf(path) + 1),
    project_id: id,
    path,
    size_bytes: 1,
    sha256: "a".repeat(64),
    mime_type: "text/plain",
    source: "upload",
    added_by: uuid(3, 1),
    added_at: NOW,
  });
  if (method === "GET" && sub === undefined) return json(200, { files: held.map(file) });
  if (method === "POST" && sub === "import") {
    const folder = typeof body?.folder === "string" ? body.folder : "";
    const path = folder === "" ? String(body?.name) : `${folder}/${String(body?.name)}`;
    if (held.includes(path)) return error(409, "already_exists");
    k.projectFiles.set(id, [...held, path]);
    return json(201, file(path));
  }
  return error(404, "not_found");
}

/** Answers its team-scoped paths; undefined for any other. */
export function projectsArea(k: FakeCore, req: FakeRequest): FakeAnswer {
  const { method, url } = req;
  const body = req.body;
  const parts = url.pathname.split("/").filter(Boolean); // v1, area, id, action, sub
  const [, area, id, action, sub] = parts;
  if (area === "projects" && id === undefined && method === "GET") {
    return json(200, { projects: k.projects });
  }
  if (area === "projects" && id === "from-folder" && method === "POST") {
    // Promote to project (KOBE-586): the folder's name makes the project; recorded in requests.
    const name = String((body as { name?: unknown } | undefined)?.name ?? "");
    const projectId = k.addProject(name);
    return json(201, { ...k.projects.find((p) => p.id === projectId), my_role: "owner" });
  }
  if (area === "projects" && id && action === "files")
    return projectFiles(k, method, id, sub, body);
  if (area === "projects" && id && action === "commits") {
    return projectCommits(k, method, id, parts.slice(4), body);
  }
  return undefined;
}
